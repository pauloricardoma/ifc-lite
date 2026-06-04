/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared bootstrap for the Dropbox edge routes. Files prefixed with `_` are not
 * routed by Vercel, so this is a plain helper module.
 */

import { type OAuthHandlers } from '../../server/cloud-oauth/oauth-handlers.js';
import { createDropboxHandlers, loadDropboxConfig } from '../../server/dropbox/dropbox.js';

let cached: OAuthHandlers | null | undefined;

/**
 * Build (and memoize) the Dropbox handlers from environment secrets. Returns
 * `null` when `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` are absent so each route
 * can answer with a clear "not configured" response instead of crashing.
 */
export function getHandlers(): OAuthHandlers | null {
  if (cached !== undefined) return cached;
  const config = loadDropboxConfig(process.env as Record<string, string | undefined>);
  cached = config ? createDropboxHandlers({ config, fetchImpl: fetch }) : null;
  return cached;
}

export function notConfigured(): Response {
  return new Response(
    JSON.stringify({ error: 'dropbox_not_configured' }),
    { status: 501, headers: { 'Content-Type': 'application/json' } },
  );
}
