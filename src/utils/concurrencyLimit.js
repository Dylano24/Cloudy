/**
 * concurrencyLimit.js — Rate-limit Discord API calls
 * Prevents 429 errors, queue overflows
 * No visible changes, pure speed improvement
 */

export class ConcurrencyLimiter {
  constructor(maxConcurrent = 5) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  async run(fn) {
    while (this.running >= this.maxConcurrent) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const resolve = this.queue.shift();
      if (resolve) resolve();
    }
  }

  async runAll(fns) {
    return Promise.all(fns.map(fn => this.run(fn)));
  }
}

// Global limiters
export const discordApiLimiter = new ConcurrencyLimiter(5);
export const databaseLimiter = new ConcurrencyLimiter(10);
export const channelFetchLimiter = new ConcurrencyLimiter(3);

export async function limitedFetch(fetcher, limiter = discordApiLimiter) {
  return limiter.run(fetcher);
}

export async function batchChannelFetches(fetches) {
  return channelFetchLimiter.runAll(fetches.map(() => async () => fetches.shift()?.()));
}

export async function batchDatabaseOps(ops) {
  return databaseLimiter.runAll(ops.map(op => async () => op()));
}

