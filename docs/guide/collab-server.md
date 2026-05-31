# Collaboration Server

`@ifc-lite/collab-server` is the reference sync server for [real-time
collaboration](collaboration.md). It's a y-websocket-compatible CRDT relay with
content-addressed blob storage and optional signed-link access control. You only
need it for multi-user sessions across machines — a single browser syncs
tab-to-tab without one.

## Quick start (local)

```sh
# 1. Build the server
pnpm --filter @ifc-lite/collab-server build

# 2. Run it (anonymous mode — open, fine for local dev)
node packages/collab-server/dist/bin.js
# → [collab-server] listening at ws://0.0.0.0:1234 (data: ./.collab-data, auth: anonymous)

# 3. Run the viewer pointed at it
VITE_COLLAB_ENABLED=true VITE_COLLAB_SERVER_URL=ws://localhost:1234 pnpm --filter viewer dev
```

There's also a one-command demo that boots the server plus a tiny client:
`pnpm collab:demo` (see [Testing collaboration](collab-testing.md)).

## Configuration

### Server (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `COLLAB_PORT` | `1234` | Listen port. |
| `COLLAB_HOST` | `0.0.0.0` | Bind address. |
| `COLLAB_DATA_DIR` | `./.collab-data` | Directory for durable Y.Doc persistence (`FilePersistence`). |
| `COLLAB_MAX_ROOMS` | `1024` | Hard cap on concurrently loaded rooms. |
| `COLLAB_TOKEN_SECRET` | _(unset)_ | **Enables signed-link access control.** Unset = anonymous (open). See [Access control](#access-control). |

!!! warning "Blob storage is in-memory in the CLI"
    The CLI server keeps geometry blobs **in memory** (lost on restart) and the
    Y.Doc on disk. For production, run the server [programmatically](#programmatic-embedding)
    and pass a durable `blobStorage` (S3, GCS, filesystem).

### Viewer (build environment)

| Variable | Example | Purpose |
| --- | --- | --- |
| `VITE_COLLAB_ENABLED` | `true` | Show the Share button + collab UI. |
| `VITE_COLLAB_SERVER_URL` | `wss://collab.example.com` | Server websocket URL. Omit for local-only (single-browser) mode. |

## Access control

By default (no `COLLAB_TOKEN_SECRET`) the server accepts **anonymous** connections
as *editor* — fine for a laptop or a trusted network, not for the public internet.

Set `COLLAB_TOKEN_SECRET` to switch on **signed room tokens**:

- Every websocket join must present a valid signed token (HS256 JWT carrying the
  room id, role, expiry, and a `jti`). Roles are tamper-proof.
- **First-touch creator → admin:** the first token minted for a brand-new room
  makes its requester admin (room creation). Afterwards, only an admin token for
  that room may mint further links — so a link holder can't escalate.
- **Revoke** (`POST /collab/revoke`, admin-only) adds a link's `jti` to a
  deny-list; future joins with it are refused.
- **Kick** (`POST /collab/kick`, admin-only) force-disconnects a peer by its
  awareness client id and revokes its token so it can't reconnect.

```sh
COLLAB_TOKEN_SECRET="$(openssl rand -hex 32)" \
COLLAB_DATA_DIR=/var/lib/ifc-collab \
node packages/collab-server/dist/bin.js
# → … (auth: room-token)
```

The viewer mints links against this server automatically (the Share dialog calls
`POST /collab/token`). The deny-list is in-memory in the CLI; for multi-instance
deployments back it with a shared store via the programmatic API.

## HTTP routes

| Route | Method | Notes |
| --- | --- | --- |
| `/<roomId>` | WS upgrade | y-websocket sync (room id is the path; `?token=` for auth). |
| `/healthz` | GET | `{ ok, rooms }`. |
| `/metrics` | GET | Prometheus text (`collab_rooms`, `collab_room_peers`, `collab_updates_total`, …). |
| `/blobs`, `/blobs/<hash>` | GET / PUT / HEAD / DELETE | Content-addressed geometry blobs. |
| `/collab/token` | POST | Mint a signed token (only when `COLLAB_TOKEN_SECRET` is set). |
| `/collab/revoke` | POST | Admin: invalidate a link by token. |
| `/collab/kick` | POST | Admin: disconnect a peer by client id. |

All HTTP routes send permissive CORS headers (reflecting the request `Origin`)
and answer `OPTIONS` preflights, so the viewer can reach them from a different
origin. Restrict or disable this via the programmatic `cors` option.

## Programmatic embedding

For custom auth policies, durable blob storage, or embedding in an existing HTTP
server, call `startCollabServer` directly:

```ts
import {
  startCollabServer,
  createRoomTokenAuthenticator,
  FilePersistence,
} from '@ifc-lite/collab-server';

const secret = process.env.COLLAB_TOKEN_SECRET!;
const revoked = new Set<string>();

const handle = await startCollabServer({
  port: 1234,
  persistence: new FilePersistence({ dataDir: '/var/lib/ifc-collab' }),
  // Verify signed tokens + consult a revocation deny-list.
  authenticate: createRoomTokenAuthenticator({ secret, isRevoked: (jti) => revoked.has(jti) }),
  // Mint policy (here: first-touch creator → admin).
  tokenEndpoint: { secret, authorize: (req, { bearerClaims }) => /* … */ },
  revokeEndpoint: { secret, recordRevocation: (jti) => { revoked.add(jti); } },
  kickEndpoint: { secret },
  // blobStorage: new S3BlobStorage(...),   // durable geometry blobs
  // cors: { origin: ['https://app.example.com'] },
});
```

See `packages/collab-server/src/bin.ts` for the exact reference policy the CLI
uses, and `packages/collab-server/src/server.ts` for every option.

## Deployment checklist

- [ ] Terminate TLS and serve over `wss://` (set `VITE_COLLAB_SERVER_URL` to the
      `wss://` URL).
- [ ] Set a strong `COLLAB_TOKEN_SECRET` (don't run public instances anonymous).
- [ ] Use durable persistence (`COLLAB_DATA_DIR` on a real volume) and a durable
      `blobStorage` (programmatic) — the in-memory blob store is dev-only.
- [ ] Scrape `/metrics` and alert on `collab_rooms` / peer counts.
- [ ] For multiple instances, share the revocation deny-list and blob store, and
      pin a room to one instance (sticky sessions) or use a shared backend.

## See also

- [Real-Time Collaboration](collaboration.md) — the user-facing feature.
- [Testing collaboration](collab-testing.md) — unit/integration/live test recipes.
- [Architecture: collaboration plan](../architecture/collab-plan.md) — the CRDT-on-IFCX design.
