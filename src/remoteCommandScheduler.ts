import { RemoteSerialQueue } from "./remoteSerialQueue.ts";

type RemoteCommandLane = "control" | "host" | "session";

interface SessionQueue {
  queue: RemoteSerialQueue;
  pending: number;
}

/**
 * Durable admission is globally serialized, while accepted long operations are
 * isolated per session. Approval/abort use a priority lane so they can resolve
 * a prompt that is itself waiting for agent_end.
 */
export class RemoteCommandScheduler {
  private readonly admission = new RemoteSerialQueue();
  private readonly control = new RemoteSerialQueue();
  private readonly host = new RemoteSerialQueue();
  private readonly sessions = new Map<string, SessionQueue>();

  admit<T>(operation: () => Promise<T>, onError?: (error: unknown) => void): Promise<T> {
    return this.admission.enqueue(operation, onError);
  }

  run<T>(
    lane: RemoteCommandLane,
    sessionId: string | undefined,
    operation: () => Promise<T>,
    onError?: (error: unknown) => void,
  ): Promise<T> {
    if (lane === "control") return this.control.enqueue(operation, onError);
    if (lane === "host") return this.host.enqueue(operation, onError);
    if (!sessionId) return Promise.reject(new Error("session command lane requires a session id"));
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = { queue: new RemoteSerialQueue(), pending: 0 };
      this.sessions.set(sessionId, entry);
    }
    entry.pending += 1;
    const selected = entry;
    const task = selected.queue.enqueue(operation, onError);
    void task.then(
      () => this.releaseSessionQueue(sessionId, selected),
      () => this.releaseSessionQueue(sessionId, selected),
    );
    return task;
  }

  private releaseSessionQueue(sessionId: string, entry: SessionQueue): void {
    entry.pending -= 1;
    if (entry.pending === 0 && this.sessions.get(sessionId) === entry) {
      this.sessions.delete(sessionId);
    }
  }
}
