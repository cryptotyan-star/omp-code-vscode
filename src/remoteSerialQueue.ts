/** A failure-tolerant FIFO for atomic remote event transactions. */
export class RemoteSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>, onError?: (error: unknown) => void): Promise<T> {
    const task = this.tail.then(operation);
    this.tail = task.then(
      () => undefined,
      (error) => { onError?.(error); },
    );
    return task;
  }
}
