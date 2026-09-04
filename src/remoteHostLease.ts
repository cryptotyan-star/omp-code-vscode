import { randomUUID } from "node:crypto";

/**
 * Cross-window single-host arbitration for the Android Remote Control relay
 * room. Every VS Code window shares one `globalState` and one relay room, but
 * the relay accepts a single host and kicks duplicates with close code 4009.
 * Each extension host owns a `RemoteHostLease` keyed on a random per-window id;
 * only the window whose record is fresh in `globalState` may connect as host.
 */

export const HOST_LEASE_KEY = "ompcode.remote.hostLease.v1";
export const HOST_LEASE_HEARTBEAT_MS = 10_000;
export const HOST_LEASE_TTL_MS = 25_000;

export interface HostLeaseRecord {
  ownerId: string;
  heartbeatAt: number;
}

/** Structural subset of `vscode.Memento` so tests can substitute a plain map. */
export interface HostLeaseStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface RemoteHostLeaseOptions {
  ownerId?: string;
  now?: () => number;
  heartbeatMs?: number;
  ttlMs?: number;
  settleMs?: number;
}

export class RemoteHostLease {
  readonly ownerId: string;
  private readonly store: HostLeaseStore;
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly ttlMs: number;
  private readonly settleMs: number;
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(store: HostLeaseStore, options: RemoteHostLeaseOptions = {}) {
    this.store = store;
    this.ownerId = options.ownerId ?? randomUUID();
    this.now = options.now ?? (() => Date.now());
    this.heartbeatMs = options.heartbeatMs ?? HOST_LEASE_HEARTBEAT_MS;
    this.ttlMs = options.ttlMs ?? HOST_LEASE_TTL_MS;
    this.settleMs = options.settleMs ?? 250;
  }

  /** The stored record, or undefined when absent or malformed. */
  current(): HostLeaseRecord | undefined {
    const value = this.store.get<HostLeaseRecord | undefined>(HOST_LEASE_KEY, undefined);
    if (!value || typeof value !== "object") return undefined;
    if (typeof value.ownerId !== "string" || typeof value.heartbeatAt !== "number") return undefined;
    return value;
  }

  /**
   * Become the host when the lease is absent, already ours, or stale. The
   * write-then-reread pair mitigates the race between two windows acquiring
   * concurrently: `globalState` has no transactions, so the loser of the write
   * race sees the winner's record on confirmation and stands down.
   */
  async tryAcquire(): Promise<boolean> {
    const existing = this.current();
    const now = this.now();
    if (existing && existing.ownerId !== this.ownerId && now - existing.heartbeatAt <= this.ttlMs) {
      return false;
    }
    await this.store.update(HOST_LEASE_KEY, { ownerId: this.ownerId, heartbeatAt: now });
    await new Promise<void>((resolve) => setTimeout(resolve, this.settleMs));
    return this.current()?.ownerId === this.ownerId;
  }

  /** Refresh the heartbeat while hosting; false when another window holds a fresh record. */
  async renew(): Promise<boolean> {
    const existing = this.current();
    if (existing && existing.ownerId !== this.ownerId && this.now() - existing.heartbeatAt <= this.ttlMs) {
      return false;
    }
    await this.store.update(HOST_LEASE_KEY, { ownerId: this.ownerId, heartbeatAt: this.now() });
    return true;
  }

  /** Renew on an interval; `onLost` fires once if another window owns the fresh record. */
  startHeartbeat(onLost: () => void): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.renew().then((kept) => {
        if (kept) return;
        this.stopHeartbeat();
        onLost();
      }, () => {});
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /** Clear the lease, but only when we still own it — never evict another window. */
  async release(): Promise<void> {
    this.stopHeartbeat();
    if (this.current()?.ownerId === this.ownerId) {
      await this.store.update(HOST_LEASE_KEY, undefined);
    }
  }
}
