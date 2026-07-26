// CLOSED / OPEN / HALF_OPEN circuit breaker around transport calls made by
// the job worker. Protects OUR application/transport integration from
// hammering a failing transport — not a mechanism for probing or evading
// any third-party rate limit.
class CircuitBreaker {
  constructor({ failureThreshold = 5, cooldownMs = 30000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this._halfOpenProbeInFlight = false;
  }

  /** Call before attempting an operation. Returns false if the breaker is OPEN (or a HALF_OPEN probe is already in flight). */
  canAttempt() {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt < this.cooldownMs) return false;
      this.state = 'HALF_OPEN';
      this._halfOpenProbeInFlight = false;
    }
    if (this.state === 'HALF_OPEN') {
      if (this._halfOpenProbeInFlight) return false;
      this._halfOpenProbeInFlight = true;
    }
    return true;
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
    this._halfOpenProbeInFlight = false;
  }

  /** Only TRANSIENT failures affect the breaker — permanent/validation failures are the recipient's problem, not the transport's. */
  recordFailure(category) {
    if (category !== 'TRANSIENT') return;

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      this._halfOpenProbeInFlight = false;
      return;
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }

  getState() {
    return this.state;
  }
}

module.exports = { CircuitBreaker };
