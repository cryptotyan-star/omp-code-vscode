import { createBlindRelay } from "./relay.mjs";

function envInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

const relay = createBlindRelay({
  maxGuestsPerRoom: envInteger("OMP_RELAY_MAX_GUESTS_PER_ROOM", undefined),
  maxFrameBytes: envInteger("OMP_RELAY_MAX_FRAME_BYTES", undefined),
  maxFramesPerSecond: envInteger("OMP_RELAY_MAX_FRAMES_PER_SECOND", undefined),
  maxBytesPerMinute: envInteger("OMP_RELAY_MAX_BYTES_PER_MINUTE", undefined),
  maxBufferedBytes: envInteger("OMP_RELAY_MAX_BUFFERED_BYTES", undefined),
  idleTimeoutMs: envInteger("OMP_RELAY_IDLE_TIMEOUT_MS", undefined),
  pingIntervalMs: envInteger("OMP_RELAY_PING_INTERVAL_MS", undefined),
});

const port = envInteger("PORT", 8787);
const host = process.env.HOST ?? "0.0.0.0";
await relay.listen(port, host);
process.stdout.write(`OMP Code blind relay listening on ${host}:${port}\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await relay.close();
  process.exitCode = 0;
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
