/** Serializes snapshot writes so a slower old write cannot overwrite a newer one. */
export class OrderedSnapshotWriter<T> {
  private tail: Promise<void> = Promise.resolve();
  private revision = 0;

  enqueue(snapshot: T, write: (snapshot: T, revision: number) => Thenable<void>): Promise<void> {
    const revision = ++this.revision;
    const task = this.tail.then(() => Promise.resolve(write(snapshot, revision)));
    this.tail = task.catch(() => {});
    return task;
  }
}
