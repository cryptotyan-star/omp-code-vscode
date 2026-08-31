import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOST_LEASE_HEARTBEAT_MS,
  HOST_LEASE_KEY,
  HOST_LEASE_TTL_MS,
  RemoteHostLease,
  type HostLeaseRecord,
} from "../src/remoteHostLease.ts";

/**
 * Regression coverage for the multi-window relay flap (relay close 4009 "room
 * exists"): every VS Code window used to connect to the shared room as host.
 * Now a `globalState` lease arbitrates — exactly one window hosts, the rest
 * stand by, and a stale owner fails over to a survivor.
 */

/**
 * `vscode.Memento` stand-in shared by every simulated window. Writes apply on
 * a microtask, modelling the cross-window visibility latency of the real
 * globalState that makes the acquire write race possible — two windows can
 * both read "no lease" before either write lands.
 */
class SharedGlobalState {
  private readonly data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return this.data.has(key) ? (this.data.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    queueMicrotask(() => {
      if (value === undefined) this.data.delete(key);
      else this.data.set(key, value);
      resolve();
    });
    return promise;
  }
}

/** One simulated VS Code window: connects to the relay room only while it holds the lease. */
class SimulatedHost {
  readonly lease: RemoteHostLease;
  connected = false;

  constructor(store: SharedGlobalState, clock: { now: number }) {
    this.lease = new RemoteHostLease(store, { now: () => clock.now, settleMs: 0 });
  }

  /** The restore()/standby-watcher path: connect only when the lease was acquired. */
  async restore(): Promise<boolean> {
    if (this.connected) return true;
    if (!(await this.lease.tryAcquire())) return false;
    this.connected = true;
    return true;
  }

  /** The heartbeat tick; a lost lease disconnects instead of fighting for the room. */
  async heartbeat(): Promise<void> {
    if (!this.connected) return;
    if (!(await this.lease.renew())) this.connected = false;
  }

  /** Graceful window close: disconnect and free the lease. */
  async stop(): Promise<void> {
    this.connected = false;
    await this.lease.release();
  }
}

test("two windows sharing one store race to host — exactly one connects, the stale owner fails over", async () => {
  const store = new SharedGlobalState();
  const clock = { now: 1_000_000 };
  const first = new SimulatedHost(store, clock);
  const second = new SimulatedHost(store, clock);

  // Both windows activate at once and race the acquisition write.
  const acquired = await Promise.all([first.restore(), second.restore()]);
  assert.equal(acquired.filter(Boolean).length, 1, "exactly one window may acquire the lease");
  assert.notEqual(first.connected, second.connected);
  const host = first.connected ? first : second;
  const standby = first.connected ? second : first;
  assert.equal(store.get<HostLeaseRecord | undefined>(HOST_LEASE_KEY, undefined)?.ownerId, host.lease.ownerId);

  // The standby window's watcher re-attempts but stays disconnected while the
  // owner's heartbeat keeps the record fresh.
  clock.now += HOST_LEASE_HEARTBEAT_MS;
  await host.heartbeat();
  assert.equal(await standby.restore(), false);
  clock.now += HOST_LEASE_HEARTBEAT_MS;
  await host.heartbeat();
  assert.equal(await standby.restore(), false);
  assert.equal(standby.connected, false);

  // The owner window dies: the heartbeat stops, the lease goes stale, and the
  // surviving window takes over the room.
  clock.now += HOST_LEASE_TTL_MS + 1;
  assert.equal(await standby.restore(), true);
  assert.equal(standby.connected, true);
  assert.equal(store.get<HostLeaseRecord | undefined>(HOST_LEASE_KEY, undefined)?.ownerId, standby.lease.ownerId);

  // The previous owner must not reconnect: its next heartbeat sees the fresh
  // foreign record and stands down for good.
  await host.heartbeat();
  assert.equal(host.connected, false);
  assert.equal(await host.restore(), false);
});

test("a graceful owner stop frees the room; a non-owner release never evicts the host", async () => {
  const store = new SharedGlobalState();
  const clock = { now: 500_000 };
  const owner = new SimulatedHost(store, clock);
  const other = new SimulatedHost(store, clock);
  assert.equal(await owner.restore(), true);

  await other.lease.release();
  assert.equal(store.get<HostLeaseRecord | undefined>(HOST_LEASE_KEY, undefined)?.ownerId, owner.lease.ownerId);
  assert.equal(await other.restore(), false);

  await owner.stop();
  assert.equal(store.get<HostLeaseRecord | undefined>(HOST_LEASE_KEY, undefined), undefined);
  assert.equal(await other.restore(), true);
  assert.equal(other.connected, true);
});

test("a malformed stored record never blocks acquisition", async () => {
  const store = new SharedGlobalState();
  await store.update(HOST_LEASE_KEY, { ownerId: 42, heartbeatAt: "not-a-number" });
  const host = new SimulatedHost(store, { now: 1 });
  assert.equal(await host.restore(), true);
  assert.equal(host.connected, true);
});
