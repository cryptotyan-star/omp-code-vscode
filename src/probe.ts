import type { OmpProcess } from "./ompProcess";

/**
 * Live check of which models the current credentials can actually talk to.
 *
 * omp lists every model of every provider it finds a credential for, but a
 * credential being *present* says nothing about it being *valid*: a stale API
 * key in Secret Storage happily produces a 17-model Kimi menu where every entry
 * answers 401. The prober sends one throwaway request per model through a
 * separate, session-less omp process and keeps only what answers.
 */

/** Verdict for one `provider/modelId` pair. */
export interface ProbeVerdict {
  ok: boolean;
  /** HTTP status when the failure carried one (401, 404, 429, …). */
  status?: number;
  detail?: string;
  /** Epoch ms — drives cache expiry. */
  checkedAt: number;
}

export type ProbeResults = Record<string, ProbeVerdict>;

export interface ProbeCandidate {
  provider: string;
  id: string;
  cost?: { input?: number } | undefined;
}

export function modelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/**
 * Failures that condemn the whole provider instead of the single model.
 * Deliberately narrow: only "we don't know who you are" (401, or an
 * auth-shaped message with no status). A model the account may not use answers
 * 403/404, and must not take its 25 siblings down with it.
 */
export function isProviderLevelFailure(verdict: ProbeVerdict): boolean {
  if (verdict.ok) {
    return false;
  }
  if (verdict.status === 401) {
    return true;
  }
  if (verdict.status !== undefined) {
    return false;
  }
  return /invalid[ _]authentication|unauthorized|no api key|not authenticated|invalid api key/i.test(
    verdict.detail ?? "",
  );
}

/**
 * Probe order: one representative model per provider first — cheapest by input
 * price, ties broken by shortest then lexicographic id — so a dead subscription
 * costs one request instead of seventeen. The rest follow, provider by provider.
 */
export function planProbeOrder(models: ProbeCandidate[]): ProbeCandidate[] {
  const byProvider = new Map<string, ProbeCandidate[]>();
  for (const model of models) {
    const list = byProvider.get(model.provider);
    if (list) {
      list.push(model);
    } else {
      byProvider.set(model.provider, [model]);
    }
  }
  const price = (m: ProbeCandidate): number =>
    typeof m.cost?.input === "number" ? m.cost.input : Number.POSITIVE_INFINITY;

  const representatives: ProbeCandidate[] = [];
  const rest: ProbeCandidate[] = [];
  for (const list of byProvider.values()) {
    const sorted = [...list].sort(
      (a, b) => price(a) - price(b) || a.id.length - b.id.length || a.id.localeCompare(b.id),
    );
    representatives.push(sorted[0]);
    rest.push(...sorted.slice(1));
  }
  return [...representatives, ...rest];
}

/** Verdicts older than this are re-probed on the next agent start. */
export const PROBE_TTL_MS = 12 * 60 * 60 * 1000;

/** True when every listed model has a fresh verdict — lets callers skip a run. */
export function isCacheFresh(
  models: ProbeCandidate[],
  results: ProbeResults,
  now: number,
  ttlMs: number = PROBE_TTL_MS,
): boolean {
  return models.every((m) => {
    const verdict = results[modelKey(m.provider, m.id)];
    return verdict !== undefined && now - verdict.checkedAt < ttlMs;
  });
}

export interface ProbeRunOptions {
  ompPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Injected so this module never owns a child process (and stays testable). */
  createProcess(): OmpProcess;
  log(line: string): void;
  onVerdict(key: string, verdict: ProbeVerdict): void;
  isCancelled?(): boolean;
}

/** Flags that strip the probe process down to "connect and answer one word". */
const PROBE_ARGS = [
  "--no-session",
  "--no-tools",
  "--no-lsp",
  "--no-skills",
  "--no-rules",
  "--no-extensions",
  "--no-title",
  "--thinking",
  "off",
  "--system-prompt",
  "You are a connectivity check. Reply with the single word: ok.",
];
const PROBE_MESSAGE = "ping";
const PROBE_TIMEOUT_MS = 45_000;
const READY_TIMEOUT_MS = 60_000;
/** Marks the one failure that is not the model's fault — worth one retry. */
export const TIMEOUT_DETAIL = "timed out";

interface Collector {
  status?: number;
  detail?: string;
  finish?: () => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Probe every model and report each verdict through `onVerdict` as it lands, so
 * the UI can narrow the menu progressively instead of waiting for the full run.
 */
export async function probeModels(
  models: ProbeCandidate[],
  opts: ProbeRunOptions,
): Promise<ProbeResults> {
  const results: ProbeResults = {};
  const order = planProbeOrder(models);
  if (!order.length) {
    return results;
  }

  const proc = opts.createProcess();
  let collector: Collector | undefined;
  let ready: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    ready = resolve;
    setTimeout(() => reject(new Error("probe agent did not become ready")), READY_TIMEOUT_MS);
  });

  proc.onFrame((frame) => {
    if (frame.type === "ready") {
      ready?.();
      return;
    }
    if (!collector) {
      return;
    }
    if (frame.type === "message_end") {
      const message = frame.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant" && message.stopReason === "error") {
        collector.status = typeof message.errorStatus === "number" ? message.errorStatus : undefined;
        collector.detail =
          typeof message.errorMessage === "string" ? message.errorMessage : "request failed";
      }
    } else if (frame.type === "agent_end") {
      collector.finish?.();
    }
  });
  proc.onStderr((text) => opts.log(`[probe] ${text.trimEnd()}`));

  proc.start({
    ompPath: opts.ompPath,
    cwd: opts.cwd,
    env: opts.env,
    approvalMode: "always-ask",
    extraArgs: PROBE_ARGS,
  });

  /** Providers already proven credential-dead — their models fail for free. */
  const deadProviders = new Map<string, ProbeVerdict>();

  try {
    await readyPromise;
    await proc.request({ type: "negotiate_protocol", protocolVersion: 2 });

    for (const model of order) {
      if (opts.isCancelled?.()) {
        break;
      }
      const key = modelKey(model.provider, model.id);
      const dead = deadProviders.get(model.provider);
      if (dead) {
        const verdict: ProbeVerdict = { ...dead, checkedAt: Date.now() };
        results[key] = verdict;
        opts.onVerdict(key, verdict);
        continue;
      }
      const setCollector = (slot: Collector | undefined): void => {
        collector = slot;
      };
      let verdict = await probeOne(proc, model, setCollector);
      if (!verdict.ok && verdict.detail === TIMEOUT_DETAIL) {
        // A timeout says nothing about the credential — a single slow first
        // token would otherwise hide a working model for the whole TTL.
        opts.log(`[probe] ${key}: timed out, retrying once`);
        verdict = await probeOne(proc, model, setCollector);
      }
      results[key] = verdict;
      opts.onVerdict(key, verdict);
      opts.log(
        `[probe] ${key}: ${verdict.ok ? "ok" : `FAIL ${verdict.status ?? ""} ${verdict.detail ?? ""}`.trim()}`,
      );
      if (isProviderLevelFailure(verdict)) {
        deadProviders.set(model.provider, verdict);
        opts.log(`[probe] provider "${model.provider}" has no usable credential — skipping its models`);
      }
    }
  } catch (err) {
    opts.log(`[probe] aborted: ${errorText(err)}`);
  } finally {
    collector = undefined;
    proc.stop();
  }

  return results;
}

async function probeOne(
  proc: OmpProcess,
  model: ProbeCandidate,
  setCollector: (collector: Collector | undefined) => void,
): Promise<ProbeVerdict> {
  const checkedAt = Date.now();
  const collector: Collector = {};
  setCollector(collector);
  try {
    // Fresh session per probe so nothing accumulates across models.
    await proc.request({ type: "new_session" });
    await proc.request({ type: "set_model", provider: model.provider, modelId: model.id });
  } catch (err) {
    setCollector(undefined);
    return { ok: false, detail: errorText(err), checkedAt };
  }

  const finished = new Promise<boolean>((resolve) => {
    collector.finish = () => resolve(true);
    setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });

  try {
    // `prompt` is acked immediately; the turn ends with agent_end.
    await proc.request({ type: "prompt", message: PROBE_MESSAGE });
  } catch (err) {
    setCollector(undefined);
    return { ok: false, detail: errorText(err), checkedAt };
  }

  const completed = await finished;
  setCollector(undefined);
  if (!completed) {
    proc.send({ type: "abort" });
    return { ok: false, detail: TIMEOUT_DETAIL, checkedAt };
  }
  if (collector.detail !== undefined || collector.status !== undefined) {
    return { ok: false, status: collector.status, detail: collector.detail, checkedAt };
  }
  return { ok: true, checkedAt };
}
