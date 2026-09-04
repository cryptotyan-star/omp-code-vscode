# OMP Code blind relay

This is the normative self-hosted relay for Remote Protocol v1. It keeps no
rooms or frames on disk and has no encryption keys. It sees only room IDs,
roles, assigned peer IDs, connection timing and byte counts. Application data
must already be end-to-end encrypted by the desktop and Android clients.

## Run locally

```sh
npm ci
npm start
```

The default listener is `0.0.0.0:8787`. The WebSocket endpoint is:

```text
ws://localhost:8787/r/<32-lowercase-hex-room-id>?role=host|guest
```

Only localhost may use plaintext `ws://`. Internet deployment must terminate
TLS at a reverse proxy and expose `wss://`. Proxy timeouts must exceed the relay
idle timeout and WebSocket upgrade headers must be forwarded.

## Docker

```sh
docker build -t omp-code-remote-relay .
docker run --rm -p 8787:8787 omp-code-remote-relay
```

Health: `GET /healthz`. The response contains aggregate connection counts only.

## Limits

All settings are positive integers:

| Environment variable | Default |
| --- | ---: |
| `OMP_RELAY_MAX_GUESTS_PER_ROOM` | 4 |
| `OMP_RELAY_MAX_FRAME_BYTES` | 393216 |
| `OMP_RELAY_MAX_FRAMES_PER_SECOND` | 120 |
| `OMP_RELAY_MAX_BYTES_PER_MINUTE` | 67108864 |
| `OMP_RELAY_MAX_BUFFERED_BYTES` | 2097152 |
| `OMP_RELAY_IDLE_TIMEOUT_MS` | 300000 |
| `OMP_RELAY_PING_INTERVAL_MS` | 30000 |

There is one host per room. Guests send peer header `0`; the relay replaces it
with their assigned non-zero sender ID before forwarding to the host. A host
uses `0` to broadcast or a non-zero ID to target one guest. Text application
frames, malformed routes, oversized frames, excessive rates and slow peers are
closed with explicit WebSocket codes.

Relay control JSON follows the native opaque-transport contract exactly:
`{"t":"peer-joined","peer":N}`, `{"t":"peer-left","peer":N}` and
`{"t":"room-closed"}`. No application data is allowed in plaintext controls.

This reference server does not claim an SLA for any public relay. A live gate on
2026-08-22 verified `my.omp.sh` native controls, guest sender rewrite, a
byte-identical 245,828-byte Android attachment wire frame, and a targeted host-to-guest reply with
TLS certificate verification enabled. Larger frames, long-term quotas, and
availability remain external service properties, so clients keep transfers
chunked and the relay origin configurable.
