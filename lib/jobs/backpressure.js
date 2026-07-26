// Bounded concurrency — never let unbounded promises/claims accumulate.
class Semaphore {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
  }

  tryAcquire() {
    if (this.active >= this.maxConcurrent) return false;
    this.active++;
    return true;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
  }
}

module.exports = { Semaphore };
