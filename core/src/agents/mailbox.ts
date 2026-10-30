/**
 * Mailboxes: messages that reach an agent while it works.
 *
 * Every run has one. Another agent's message (a reply from an agent it
 * wrote to without waiting, a question from one working for it, a follow-up
 * from the one it works for) waits there until the run's next step, when it
 * joins the model's context as a message. A run can also wait for its
 * mailbox: an agent that asked something and has nothing else to do.
 */

export interface MailItem {
  /** The agent it is from. */
  from: string;
  /** The thread key it came through. */
  thread?: string;
  /** What the model reads. */
  content: string;
  /**
   * Records it where the receiving run is recorded, when it joins the run's
   * context. Not called when a waiting tool call takes it as its result.
   */
  record?: () => void;
}

export class Mailbox {
  private items: MailItem[] = [];
  private waiters: Array<() => void> = [];

  get size(): number {
    return this.items.length;
  }

  deliver(item: MailItem): void {
    this.items.push(item);
    const wake = this.waiters;
    this.waiters = [];
    wake.forEach((w) => w());
  }

  /** Everything waiting, oldest first. */
  take(): MailItem[] {
    return this.items.splice(0);
  }

  /** Takes the oldest item that matches, if any. */
  takeOne(match: (item: MailItem) => boolean): MailItem | undefined {
    const i = this.items.findIndex(match);
    return i < 0 ? undefined : this.items.splice(i, 1)[0];
  }

  /** Resolves when something arrives (at once if something is waiting). */
  changed(signal?: AbortSignal): Promise<void> {
    if (this.items.length) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' }));
      };
      const done = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(done);
    });
  }

  /** Waits for an item that matches and takes it. */
  async next(match: (item: MailItem) => boolean, signal?: AbortSignal): Promise<MailItem> {
    for (;;) {
      const found = this.takeOne(match);
      if (found) return found;
      await this.waitForNew(signal);
    }
  }

  /** Resolves on the next delivery, even when items are already waiting. */
  private waitForNew(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' }));
      };
      const done = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(done);
    });
  }
}

/** Resolves after `ms`, or rejects when `signal` aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
