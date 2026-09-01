/**
 * AsyncQueue — serializes command execution per draft.
 *
 * Constraint: one mutating command in flight at a time per draft.
 * All bid/nomination/award commands enqueue here; the queue drains sequentially.
 */
export class AsyncQueue {
  private tasks: Array<() => Promise<void>> = [];
  private running = false;

  enqueue(task: () => Promise<void>): void {
    this.tasks.push(task);
    if (!this.running) {
      this.drain().catch((err) => {
        console.error('[AsyncQueue] drain error:', err);
      });
    }
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.tasks.length > 0) {
      const task = this.tasks.shift()!;
      try {
        await task();
      } catch (err) {
        console.error('[AsyncQueue] task error:', err);
      }
    }
    this.running = false;
  }
}
