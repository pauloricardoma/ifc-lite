# @ifc-lite/collab-server

Reference websocket sync server for [`@ifc-lite/collab`](../collab).

> **Status: v0.2.** y-websocket-compatible sync, append-only file persistence,
> content-addressed blob route, healthcheck + Prometheus metrics, and
> **signed-link access control** (room tokens with a first-touch-creator-admin
> policy, revoke, and kick). Pluggable blob storage (S3/GCS/filesystem) via the
> programmatic API. See the [Collaboration Server guide](../../docs/guide/collab-server.md).

## Run it

```sh
pnpm --filter @ifc-lite/collab-server build
pnpm --filter @ifc-lite/collab-server start
# default port 1234, persistence at ./.collab-data/, auth: anonymous

# With signed-link access control (recommended off localhost):
COLLAB_TOKEN_SECRET="$(openssl rand -hex 32)" \
pnpm --filter @ifc-lite/collab-server start            # → auth: room-token
```

Environment variables:

| Var | Default | Purpose |
|---|---|---|
| `COLLAB_PORT` | `1234` | Listen port |
| `COLLAB_HOST` | `0.0.0.0` | Listen host |
| `COLLAB_DATA_DIR` | `./.collab-data` | Persistence root for room logs |
| `COLLAB_TOKEN_SECRET` | _(unset = anonymous)_ | HMAC secret that **enables room-token auth**. Unset → open (anonymous editor). |
| `COLLAB_MAX_ROOMS` | `1024` | Soft cap on simultaneous rooms |

HTTP routes: `GET /healthz`, `GET /metrics`, `/blobs[/<hash>]`, and — when a
secret is set — `POST /collab/token`, `POST /collab/revoke`, `POST /collab/kick`.
All carry permissive CORS by default. The CLI keeps blobs in memory and the
revocation list in process; use a durable `blobStorage` + shared deny-list via
the programmatic API for production / multi-instance.

## Programmatic use

```ts
import { startCollabServer } from '@ifc-lite/collab-server';

const server = await startCollabServer({
  port: 4444,
  authenticate: async (token, room) => {
    if (!verify(token)) return null;
    return { userId: 'louis', role: 'editor' };
  },
});

// Later:
await server.stop();
```

## License

MPL-2.0
