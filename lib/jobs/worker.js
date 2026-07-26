// Polls for claimable job items, executes them through the Transport
// abstraction, and drives retry/circuit-breaker/backpressure. One instance
// runs in this process; the claiming transaction (lib/jobs/claiming.js) is
// already correct for multiple instances sharing one SQLite file if this is
// ever split into separate worker processes.
const { claimNextItem, recoverStaleClaims } = require('./claiming');
const { classifyOutcome, classifyException, isRetryable } = require('./errorClassifier');
const { MAX_ATTEMPTS, computeBackoffMs } = require('./retry');
const { CircuitBreaker } = require('./circuitBreaker');
const { Semaphore } = require('./backpressure');
const jobService = require('./jobService');
const { isOutboundDisabled } = require('../killSwitch');

const TICK_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class JobWorker {
  constructor(transport, { logger, concurrency = 5, onJobSettled } = {}) {
    this.transport = transport;
    this.logger = logger;
    this.onJobSettled = onJobSettled || (() => {});
    this.workerId = `worker-${process.pid}`;
    this.semaphore = new Semaphore(concurrency);
    this.breaker = new CircuitBreaker();
    this._interval = null;
    this._draining = false;
    this._inFlight = new Set();
  }

  /** Crash recovery — call once at startup, before start(). */
  recoverOnStartup() {
    const recovered = recoverStaleClaims();
    if (recovered > 0 && this.logger) this.logger.warn({ recovered }, 'job_worker_recovered_stale_claims');
    return recovered;
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this._tick(), TICK_INTERVAL_MS);
  }

  _tick() {
    if (this._draining) return;
    if (isOutboundDisabled()) return;

    for (;;) {
      if (!this.semaphore.tryAcquire()) return;
      if (!this.breaker.canAttempt()) {
        this.semaphore.release();
        return;
      }
      const item = claimNextItem(this.workerId);
      if (!item) {
        this.semaphore.release();
        return;
      }
      const promise = this._processItem(item)
        .catch((err) => this.logger && this.logger.error({ err, itemId: item.id }, 'job_item_processing_error'))
        .finally(() => {
          this.semaphore.release();
          this._inFlight.delete(promise);
        });
      this._inFlight.add(promise);
    }
  }

  async _processItem(item) {
    jobService.markItemRunning(item.id);
    const attemptNumber = item.attempt_count + 1;
    jobService.recordAttemptStart(item.id, attemptNumber);

    let outcomeStatus;
    let category;
    let detail = null;

    try {
      const [result] = await this.transport.sendToNumbers([item.recipient_number], item.message, 0);
      outcomeStatus = result.status;
      detail = result.detail || null;
      category = classifyOutcome(outcomeStatus);
    } catch (err) {
      outcomeStatus = 'error';
      detail = err.message;
      category = classifyException(err);
    }

    jobService.recordAttemptFinish(item.id, attemptNumber, outcomeStatus, category, detail);

    if (category === null) {
      this.breaker.recordSuccess();
      jobService.markItemTerminal(item.id, 'succeeded');
    } else {
      this.breaker.recordFailure(category);
      const retryable = isRetryable(category) && attemptNumber < MAX_ATTEMPTS;
      if (retryable) {
        const delay = computeBackoffMs(attemptNumber);
        jobService.scheduleRetry(item.id, Date.now() + delay, category, detail);
      } else {
        const terminalStatus = category === 'VALIDATION' ? 'skipped' : 'failed';
        jobService.markItemTerminal(item.id, terminalStatus, category, detail);
      }
    }

    const settledJob = jobService.checkJobCompletion(item.job_id);
    if (settledJob) this.onJobSettled(settledJob);
  }

  /** Graceful shutdown: stop claiming new items, let in-flight ones finish within timeoutMs. */
  async drainAndStop(timeoutMs = 10000) {
    this._draining = true;
    if (this._interval) clearInterval(this._interval);
    this._interval = null;

    const start = Date.now();
    while (this._inFlight.size > 0 && Date.now() - start < timeoutMs) {
      await Promise.race([...this._inFlight, sleep(50)]);
    }
  }
}

module.exports = JobWorker;
