/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dropbox OAuth provider definition. All flow logic lives in the shared
 * `cloud-oauth` core; this file only describes Dropbox's endpoints and scopes.
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

export const DROPBOX_SPEC: OAuthProviderSpec = {
  id: 'dropbox',
  authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
  tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
  // Minimal scopes: list folders, read file content, read account display name.
  scopes: ['account_info.read', 'files.metadata.read', 'files.content.read'],
  // `offline` is what makes Dropbox return a durable refresh token.
  authorizeParams: { token_access_type: 'offline' },
  envKeys: { id: 'DROPBOX_APP_KEY', secret: 'DROPBOX_APP_SECRET' },
};

export function loadDropboxConfig(env: Record<string, string | undefined>): OAuthClientConfig | null {
  return loadOAuthConfig(DROPBOX_SPEC, env);
}

export function createDropboxHandlers(deps: {
  config: OAuthClientConfig;
  fetchImpl?: typeof fetch;
  makeState?: () => string;
}): OAuthHandlers {
  return createOAuthHandlers({ spec: DROPBOX_SPEC, ...deps });
}
