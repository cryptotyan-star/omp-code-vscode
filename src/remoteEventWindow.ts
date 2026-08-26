interface DeferredAck {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** Cumulative ACK window shared by full-sync and live event delivery. */
export class RemoteEventAckWindow {
  private highWater: bigint;
  private readonly maximumOutstanding: number;
  private readonly timeoutMs: number;
  private readonly onTimeout?: (sequence: bigint, error: Error) => void;
  private readonly pending = new Map<bigint, DeferredAck>();

  constructor(
    highWater: bigint,
    maximumOutstanding = 4,
    timeoutMs = 30_000,
    onTimeout?: (sequence: bigint, error: Error) => void,
  ) {
    if (maximumOutstanding < 1 || !Number.isSafeInteger(maximumOutstanding)) {
      throw new Error("event ACK window must be a positive integer");
    }
    this.highWater = highWater;
    this.maximumOutstanding = maximumOutstanding;
    this.timeoutMs = timeoutMs;
    this.onTimeout = onTimeout;
  }

  get acknowledgedThrough(): bigint {
    return this.highWater;
  }

  get outstandingCount(): number {
    return this.pending.size;
  }

  /** Wait for capacity, then reserve one strictly increasing event sequence. */
  async reserve(sequence: bigint): Promise<{ ack: Promise<void> }> {
    while (this.pending.size >= this.maximumOutstanding) {
      const oldest = this.pending.values().next().value as DeferredAck | undefined;
      if (!oldest) break;
      await oldest.promise;
    }
    if (sequence <= this.highWater) return { ack: Promise.resolve() };
    if (this.pending.has(sequence)) return { ack: this.pending.get(sequence)?.promise ?? Promise.resolve() };
    let resolveAck: () => void = () => {};
    let rejectAck: (error: Error) => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      resolveAck = resolve;
      rejectAck = reject;
    });
    // The final few events in a burst may not have a direct awaiter; suppress
    // unhandled rejection while explicit callers can still await `promise`.
    void promise.catch(() => {});
    const timer = setTimeout(() => {
      this.pending.delete(sequence);
      const error = new Error(`event ACK timeout at sequence ${sequence.toString(10)}`);
      rejectAck(error);
      this.onTimeout?.(sequence, error);
    }, this.timeoutMs);
    this.pending.set(sequence, { promise, resolve: resolveAck, reject: rejectAck, timer });
    return { ack: promise };
  }

  /** Apply one cumulative ACK and release every earlier reservation. */
  acknowledge(sequence: bigint): void {
    if (sequence <= this.highWater) return;
    this.highWater = sequence;
    for (const [pendingSequence, deferred] of this.pending) {
      if (pendingSequence <= sequence) {
        clearTimeout(deferred.timer);
        this.pending.delete(pendingSequence);
        deferred.resolve();
      }
    }
  }

  reject(sequence: bigint, reason: string): void {
    const deferred = this.pending.get(sequence);
    if (!deferred) return;
    clearTimeout(deferred.timer);
    this.pending.delete(sequence);
    deferred.reject(new Error(reason));
  }

  close(reason: string): void {
    for (const deferred of this.pending.values()) {
      clearTimeout(deferred.timer);
      deferred.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
