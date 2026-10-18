/** Counting semaphore used to enforce maxConcurrentChildren. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get inUse(): number {
    return this.active;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(signal?.reason ?? new Error('aborted'));
        };
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        this.waiters.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}
