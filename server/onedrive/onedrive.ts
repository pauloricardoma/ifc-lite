/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * OneDrive / Microsoft Graph OAuth provider definition. All flow logic lives in
 * the shared `cloud-oauth` core; this file only describes Microsoft's endpoints
 * and scopes.
 *
 * The `common` tenant accepts both work/school (Entra ID) and personal Microsoft
 * accounts. Single-tenant deployments can pin the tenant by replacing `common`
 * in the URLs below. `offline_access` is what makes Microsoft return a durable
 * refresh token.
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

const TENANT = 'common';

export const ONEDRIVE_SPEC: OAuthProviderSpec = {
  id: 'onedrive',
  authorizeUrl: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
  tokenUrl: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
  // offline_access → refresh token; Files.Read.All covers the user's OneDrive
  // plus files/SharePoint libraries shared with them.
  scopes: ['offline_access', 'Files.Read.All', 'User.Read'],
  authorizeParams: {},
  envKeys: { id: 'MICROSOFT_CLIENT_ID', secret: 'MICROSOFT_CLIENT_SECRET' },
};

export function loadOneDriveConfig(env: Record<string, string | undefined>): OAuthClientConfig | null {
  return loadOAuthConfig(ONEDRIVE_SPEC, env);
}

export function createOneDriveHandlers(deps: {
  config: OAuthClientConfig;
  fetchImpl?: typeof fetch;
  makeState?: () => string;
}): OAuthHandlers {
  return createOAuthHandlers({ spec: ONEDRIVE_SPEC, ...deps });
}
