/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Google Drive OAuth provider definition. All flow logic lives in the shared
 * `cloud-oauth` core; this file only describes Google's endpoints and scopes.
 *
 * `access_type=offline` + `prompt=consent` are required for Google to return a
 * durable refresh token (and to re-issue it on every consent, so a fresh
 * connection always gets one).
 */

import {
  type OAuthClientConfig,
  type OAuthProviderSpec,
  loadOAuthConfig,
} from '../cloud-oauth/oauth-core.js';
import {
  type OAuthHandlers,
  createOAuthHandlers,
} from '../cloud-oauth/oauth-handlers.js';

export const GOOGLE_SPEC: OAuthProviderSpec = {
  id: 'google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  // Read-only access to browse folders and download file content.
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  authorizeParams: {
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  },
  envKeys: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
};

export function loadGoogleConfig(env: Record<string, string | undefined>): OAuthClientConfig | null {
  return loadOAuthConfig(GOOGLE_SPEC, env);
}

export function createGoogleHandlers(deps: {
  config: OAuthClientConfig;
  fetchImpl?: typeof fetch;
  makeState?: () => string;
}): OAuthHandlers {
  return createOAuthHandlers({ spec: GOOGLE_SPEC, ...deps });
}
