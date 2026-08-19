import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { OmpProcess } from "./ompProcess";
import { resolveLaunch, resolveWindowsExecutable } from "./winLaunch.ts";
import type { ProbeResults } from "./probe";

/**
 * Self-test that answers "why does nothing work" with facts instead of guesses:
 * does the binary run, does the agent reach `ready`, which providers hold a
 * credential, which models does omp offer, and what did the last verification
 * conclude. Everything runs against a session-less agent so it cannot disturb
 * an open chat.
 */

export interface DiagnosticsInput {
  ompPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Names only — values must never reach the report. */
  injectedEnvKeys: string[];
  probeResults: ProbeResults;
  config: Record<string, unknown>;
}

const START_TIMEOUT_MS = 60_000;

function runVersion(ompPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    const target = resolveLaunch({ file: ompPath, args: ["--version"], env });
    if (target.problem) {
      resolve(`FAILED to spawn: ${target.problem}`);
      return;
    }
    const child = spawn(target.file, target.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: target.windowsVerbatimArguments,
    });
    const done = (text: string): void => resolve(text.trim() || "(no output)");
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (err: Error) => done(`FAILED to spawn: ${err.message}`));
    child.on("exit", () => done(out));
    setTimeout(() => {
      child.kill();
      done(out || "timed out");
    }, 15_000);
  });
}

export async function runDiagnostics(input: DiagnosticsInput): Promise<string> {
  const lines: string[] = [];
  const add = (line = ""): number => lines.push(line);

  add("# OMP Code diagnostics");
  add();
  add(`- omp path setting: \`${input.ompPath}\``);
  if (process.platform === "win32") {
    const resolved = resolveWindowsExecutable(input.ompPath, input.env);
    add(`- resolved launcher: \`${resolved ?? "(not found on PATH)"}\``);
  }
  add(`- workspace cwd: \`${input.cwd}\``);
  add(`- PATH contains ~/.bun/bin: ${String(input.env.PATH ?? "").includes(path.join(os.homedir(), ".bun", "bin"))}`);
  add(
    `- API-key env vars injected by the extension: ${
      input.injectedEnvKeys.length ? input.injectedEnvKeys.join(", ") : "(none)"
    }`,
  );
  add();
  add("## omp --version");
  add("```");
  add(await runVersion(input.ompPath, input.env));
  add("```");
  add();

  add("## Agent handshake");
  const proc = new OmpProcess();
  let ready: (() => void) | undefined;
  let failed: ((err: Error) => void) | undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
    setTimeout(() => reject(new Error(`no "ready" frame within ${START_TIMEOUT_MS / 1000}s`)), START_TIMEOUT_MS);
  });
  let stderr = "";
  proc.onStderr((text) => {
    stderr = (stderr + text).slice(-2000);
  });
  proc.onFrame((frame) => {
    if (frame.type === "ready") {
      ready?.();
    }
  });
  // Without this the report waits out the full timeout and then blames a
  // missing "ready" frame, hiding the actual reason (a missing binary, or a
  // launcher winLaunch refused).
  proc.onError((err) => {
    failed?.(new Error(err.message));
  });

  try {
    proc.start({
      ompPath: input.ompPath,
      cwd: input.cwd,
      env: input.env,
      approvalMode: "always-ask",
      extraArgs: ["--no-session", "--no-tools", "--no-lsp", "--no-skills", "--no-rules", "--no-extensions"],
    });
    await readyPromise;
    add("- ready frame: OK");
    await proc.request({ type: "negotiate_protocol", protocolVersion: 2 });
    add("- negotiate_protocol: OK");

    const providers = await proc.request({ type: "get_login_providers" });
    const list = (providers as { providers?: Array<Record<string, unknown>> })?.providers ?? [];
    const signedIn = list.filter((p) => p.authenticated === true).map((p) => String(p.id));
    add();
    add("## Signed-in providers");
    add(signedIn.length ? signedIn.map((id) => `- ${id}`).join("\n") : "- (none)");

    const modelData = await proc.request({ type: "get_available_models" });
    const models = ((modelData as { models?: Array<Record<string, unknown>> })?.models ?? []).map((m) => ({
      provider: String(m.provider ?? "?"),
      id: String(m.id ?? "?"),
    }));
    const byProvider = new Map<string, string[]>();
    for (const m of models) {
      const bucket = byProvider.get(m.provider);
      if (bucket) {
        bucket.push(m.id);
      } else {
        byProvider.set(m.provider, [m.id]);
      }
    }
    add();
    add(`## Models offered by omp (${models.length})`);
    for (const [provider, ids] of byProvider) {
      add(`- **${provider}** (${ids.length}): ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? " …" : ""}`);
    }
  } catch (err) {
    add(`- FAILED: ${err instanceof Error ? err.message : String(err)}`);
    if (stderr) {
      add();
      add("### agent stderr");
      add("```");
      add(stderr.trim());
      add("```");
    }
  } finally {
    proc.stop();
  }

  const verdicts = Object.entries(input.probeResults);
  add();
  add(`## Last verification (${verdicts.length} verdicts)`);
  if (!verdicts.length) {
    add("- empty — verification has not completed. Run ⚙ → \"Re-check which models work\" and watch the");
    add("  \"OMP Code\" output channel for `[probe]` lines.");
  } else {
    const ok = verdicts.filter(([, v]) => v.ok);
    add(`- usable: ${ok.length} / ${verdicts.length}`);
    for (const [key, v] of verdicts) {
      add(`  - ${v.ok ? "PASS" : "FAIL"} \`${key}\`${v.ok ? "" : ` — ${v.status ?? ""} ${(v.detail ?? "").split("\n")[0]}`}`);
    }
  }

  add();
  add("## Settings");
  for (const [key, value] of Object.entries(input.config)) {
    add(`- \`ompcode.${key}\` = ${JSON.stringify(value)}`);
  }

  return lines.join("\n") + "\n";
}
