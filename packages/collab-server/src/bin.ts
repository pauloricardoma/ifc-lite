#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** CLI entry point: `ifc-lite-collab-server`. */

import { FilePersistence, startCollabServer, type StartCollabServerOptions } from './server.js';
import { createRoomTokenAuthenticator } from './room-token.js';
import { type Role } from './auth.js';

const port = Number(process.env.COLLAB_PORT ?? 1234);
const host = process.env.COLLAB_HOST ?? '0.0.0.0';
const dataDir = process.env.COLLAB_DATA_DIR ?? './.collab-data';
const maxRooms = Number(process.env.COLLAB_MAX_ROOMS ?? 1024);
// Link-based access control is enabled by setting a signing secret. Without it
// the server stays open (anonymous editor) — fine for local/dev, see auth.ts.
const tokenSecret = process.env.COLLAB_TOKEN_SECRET;

/**
 * Accountless room access control:
 *   - Joins require a valid signed room token (role is tamper-proof + revocable).
 *   - The *first* token minted for a brand-new room makes its requester admin
 *     (room creation / first-touch). Afterwards only an admin token for that
 *     room may mint further links — so a link's holder can't escalate.
 *   - Admins can revoke a link by `jti` (deny-list).
 */
function tokenOptions(secret: string): Partial<StartCollabServerOptions> {
  const revoked = new Set<string>();
  const claimedRooms = new Set<string>();
  return {
    authenticate: createRoomTokenAuthenticator({ secret, isRevoked: (jti) => revoked.has(jti) }),
    tokenEndpoint: {
      secret,
      authorize: (request, { bearerClaims }): Role | null => {
        const room = request.roomId;
        if (bearerClaims?.room === room && bearerClaims.role === 'admin') return request.role;
        if (!claimedRooms.has(room)) {
          claimedRooms.add(room);
          return 'admin'; // creator of a fresh room
        }
        return null; // claimed room + non-admin caller → denied
      },
    },
    revokeEndpoint: {
      secret,
      recordRevocation: (jti) => {
        revoked.add(jti);
      },
    },
  };
}

async function main() {
  const handle = await startCollabServer({
    port,
    host,
    persistence: new FilePersistence({ dataDir }),
    maxRooms,
    ...(tokenSecret ? tokenOptions(tokenSecret) : {}),
  });
  // eslint-disable-next-line no-console
  console.log(
    `[collab-server] listening at ${handle.url} (data: ${dataDir}, auth: ${tokenSecret ? 'room-token' : 'anonymous'})`,
  );

  const shutdown = async () => {
    // eslint-disable-next-line no-console
    console.log('[collab-server] shutting down…');
    await handle.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[collab-server] fatal:', err);
  process.exit(1);
});
