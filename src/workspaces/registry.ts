/**
 * Persistence for workspace records, plus the reconciliation that keeps them
 * honest against what git actually has.
 *
 * The registry is the extension's memory of workspaces; `git worktree` is the
 * truth. They drift apart whenever someone removes a worktree by hand, wipes
 * the directory, or runs `git worktree prune` outside VS Code — so every
 * record is checked against a live `git worktree list` rather than trusted.
 *
 * Storage goes through a structural `WorkspaceStore` instead of
 * `vscode.Memento` so the whole file stays testable outside the extension
 * host; a `Memento` satisfies the interface as-is.
 */

// The `.ts` extension is deliberate: this module is imported by `node --test`,
// which resolves specifiers literally, and only a type-only import can go
// without it.
import { samePath, type WorktreeEntry } from "./git.ts";
import type { ApprovalMode } from "../ompSession";
import type { WorkspaceRecord, WorkspaceSetupState } from "./types";

/** Structurally compatible with `vscode.Memento`. */
export interface WorkspaceStore {
  get<T>(key: string, def: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * Versioned so a future record shape can be migrated by reading the old key
 * rather than by silently mis-parsing the new one.
 */
export const WORKSPACES_KEY = "ompcode.workspaces.v1";

export interface ReconcileResult {
  kept: WorkspaceRecord[];
  /** Records whose worktree git no longer knows about. */
  orphaned: WorkspaceRecord[];
}

/**
 * Exhaustive over `ApprovalMode`: adding a mode to `ompSession` without adding
 * it here is a compile error, so a stored record can never be dropped just
 * because the union grew.
 */
const APPROVAL_MODES: { [K in ApprovalMode]: true } = {
  "always-ask": true,
  write: true,
  yolo: true,
};

const SETUP_STATES: { [K in WorkspaceSetupState]: true } = {
  pending: true,
  running: true,
  done: true,
  failed: true,
  skipped: true,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * A record is only kept if every field the rest of the layer dereferences is
 * present and of the right type. Half-valid records are dropped rather than
 * repaired: a workspace missing its `worktreePath` or `baseSha` cannot be
 * diffed or deleted safely, and carrying it forward would only surface as a
 * crash later.
 */
export function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    isNonEmptyString(r["id"]) &&
    isNonEmptyString(r["name"]) &&
    isNonEmptyString(r["repoRoot"]) &&
    isNonEmptyString(r["worktreePath"]) &&
    isNonEmptyString(r["branch"]) &&
    isNonEmptyString(r["baseRef"]) &&
    isNonEmptyString(r["baseSha"]) &&
    typeof r["createdAt"] === "number" &&
    Number.isFinite(r["createdAt"]) &&
    optionalString(r["model"]) &&
    optionalString(r["sessionFile"]) &&
    (r["approvalMode"] === undefined ||
      (typeof r["approvalMode"] === "string" && r["approvalMode"] in APPROVAL_MODES)) &&
    typeof r["setupState"] === "string" &&
    r["setupState"] in SETUP_STATES
  );
}

/**
 * Split stored records into the ones git still has a worktree for and the ones
 * it does not. Pure, so the interesting half of orphan handling is testable
 * without a repository on disk.
 *
 * The main checkout is skipped when matching: a record must correspond to a
 * *linked* worktree. Otherwise a stale record whose directory happened to be
 * the repo root would look alive forever.
 */
export function reconcile(records: WorkspaceRecord[], live: WorktreeEntry[]): ReconcileResult {
  const linked = live.filter((entry) => !entry.isMain && !entry.bare);
  const kept: WorkspaceRecord[] = [];
  const orphaned: WorkspaceRecord[] = [];
  for (const record of records) {
    if (linked.some((entry) => samePath(entry.path, record.worktreePath))) {
      kept.push(record);
    } else {
      orphaned.push(record);
    }
  }
  return { kept, orphaned };
}

type Listener = () => void;

/**
 * A three-line event emitter rather than `vscode.EventEmitter`, so the
 * registry stays importable from tests.
 */
class ChangeEmitter {
  private readonly listeners = new Set<Listener>();

  readonly event = (listener: Listener): { dispose(): void } => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  fire(): void {
    // Copy first: a listener that disposes itself must not skip the next one.
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

export class WorkspaceRegistry {
  private readonly changed = new ChangeEmitter();
  private readonly store: WorkspaceStore;
  private records: WorkspaceRecord[];
  /** Serializes writes; see {@link write}. */
  private queue: Promise<void> = Promise.resolve();

  readonly onDidChange = this.changed.event;

  constructor(store: WorkspaceStore) {
    this.store = store;
    this.records = WorkspaceRegistry.read(store);
  }

  /**
   * Anything in storage that is not a well-formed record is skipped, not
   * thrown on. Globals survive extension downgrades and hand edits, and one
   * bad entry must not cost the user every other workspace.
   */
  private static read(store: WorkspaceStore): WorkspaceRecord[] {
    const raw: unknown = store.get<unknown>(WORKSPACES_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: WorkspaceRecord[] = [];
    for (const entry of raw) {
      if (isWorkspaceRecord(entry)) {
        // Normalise: drop keys we do not own so a round-trip stays stable.
        out.push({ ...entry });
      }
    }
    return out;
  }

  list(): WorkspaceRecord[] {
    return [...this.records];
  }

  get(id: string): WorkspaceRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  async upsert(record: WorkspaceRecord): Promise<void> {
    await this.write((current) => {
      const next = [...current];
      const at = next.findIndex((existing) => existing.id === record.id);
      if (at === -1) {
        next.push(record);
      } else {
        next[at] = record;
      }
      return next;
    });
  }

  async remove(id: string): Promise<void> {
    await this.write((current) => {
      const next = current.filter((record) => record.id !== id);
      return next.length === current.length ? undefined : next;
    });
  }

  /**
   * Apply a mutation to the stored list.
   *
   * Writes are serialized through a promise chain and the mutation is computed
   * inside its own turn, from the list as it is *then*. Two overlapping writes
   * (a create finishing while a setup state lands) would otherwise both build
   * on the same pre-mutation snapshot, and the second would silently erase the
   * first — leaving a worktree on disk with no row and no way to delete it.
   *
   * The in-memory list is only swapped in after the store accepted the write,
   * so a failed `update` leaves the registry describing what is on disk.
   */
  private write(
    mutate: (current: WorkspaceRecord[]) => WorkspaceRecord[] | undefined,
  ): Promise<void> {
    const step = this.queue.then(async () => {
      const next = mutate(this.records);
      if (!next) {
        return;
      }
      await this.store.update(WORKSPACES_KEY, next);
      this.records = next;
      this.changed.fire();
    });
    // The chain must survive a rejected write, or every later mutation would
    // inherit the failure; the caller still sees it through `step`.
    this.queue = step.catch(() => undefined);
    return step;
  }
}
