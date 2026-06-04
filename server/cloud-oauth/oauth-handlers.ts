/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generic request handlers for the four OAuth routes, built on the pure helpers
 * in `oauth-core.ts` and parameterised by an `OAuthProviderSpec`. Every cloud
 * provider reuses these — only the spec (endpoints, scopes, id) differs.
 *
 *   GET  /api/<id>/auth-start     → redirect to the provider consent screen
 *   GET  /api/<id>/auth-callback  → exchange code, set refresh cookie, close popup
 *   POST /api/<id>/token          → mint a short-lived access token from the cookie
 *   POST /api/<id>/disconnect     → clear the refresh cookie
 *
 * Each handler is a `(Request) => Promise<Response>` so it works in both the
 * Vercel edge runtime and the local node dev server, and is directly testable.
 */

import {
  type OAuthClientConfig,
  type OAuthProviderSpec,
  buildAuthorizeUrl,
  cookiePath,
  exchangeCodeForTokens,
  parseCookies,
  randomState,
  redirectUriFor,
  refreshAccessToken,
  refreshCookieName,
  serializeCookie,
  stateCookieName,
} from './oauth-core.js';

/** Same-origin localStorage key the popup writes to signal the opener. */
export const AUTH_RESULT_STORAGE_KEY = 'ifc-lite:cloud:auth-result';

export interface OAuthHandlerDeps {
  spec: OAuthProviderSpec;
  config: OAuthClientConfig;
  fetchImpl?: typeof fetch;
  /** Override for tests; defaults to `randomState()`. */
  makeState?: () => string;
}

export interface OAuthHandlers {
  authStart: (req: Request) => Promise<Response>;
  authCallback: (req: Request) => Promise<Response>;
  token: (req: Request) => Promise<Response>;
  disconnect: (req: Request) => Promise<Response>;
}

const REFRESH_MAX_AGE = 60 * 60 * 24 * 365; // ~1 year
const STATE_MAX_AGE = 60 * 10; // 10 minutes to complete consent

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/**
 * HTML returned to the popup after the consent round-trip. It signals the opener
 * via a same-origin `localStorage` write (the `storage` event fires in the main
 * window) and closes itself. We use localStorage rather than
 * `window.opener.postMessage` because the app sets
 * `Cross-Origin-Opener-Policy: same-origin`, which severs the opener handle once
 * the popup has visited the provider's domain.
 */
function popupResultHtml(spec: OAuthProviderSpec, ok: boolean, message: string): string {
  const payload = JSON.stringify({ provider: spec.id, ok, message, ts: Date.now() });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${spec.id}</title></head>
<body style="font-family:system-ui;background:#0b0b0f;color:#e5e7eb;display:grid;place-items:center;height:100vh;margin:0">
<p>${ok ? 'Connected. You can close this window.' : `Connection failed: ${message}`}</p>
<script>
  try { localStorage.setItem(${JSON.stringify(AUTH_RESULT_STORAGE_KEY)}, ${JSON.stringify(payload)}); } catch (e) { console.error(e); }
  setTimeout(function () { try { window.close(); } catch (e) { /* user closes manually */ } }, ${ok ? 300 : 2500});
</script>
</body></html>`;
}

export function createOAuthHandlers(deps: OAuthHandlerDeps): OAuthHandlers {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const makeState = deps.makeState ?? (() => randomState());
  const { spec, config } = deps;
  const STATE_COOKIE = stateCookieName(spec);
  const REFRESH_COOKIE = refreshCookieName(spec);
  const PATH = cookiePath(spec);

  const cookie = (name: string, value: string, maxAge: number): string =>
    serializeCookie(name, value, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge, path: PATH });

  async function authStart(req: Request): Promise<Response> {
    const state = makeState();
    const redirectUri = redirectUriFor(spec, req.url);
    const location = buildAuthorizeUrl(spec, { clientId: config.clientId, redirectUri, state });
    return new Response(null, {
      status: 302,
      headers: { Location: location, 'Set-Cookie': cookie(STATE_COOKIE, state, STATE_MAX_AGE) },
    });
  }

  async function authCallback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');
    const cookies = parseCookies(req.headers.get('cookie'));
    const expectedState = cookies[STATE_COOKIE];
    const clearedState = cookie(STATE_COOKIE, '', 0);

    const html = (ok: boolean, message: string, status: number, setCookies: string[]): Response => {
      const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
      for (const c of setCookies) headers.append('Set-Cookie', c);
      return new Response(popupResultHtml(spec, ok, message), { status, headers });
    };

    if (oauthError) {
      return html(false, oauthError, 400, [clearedState]);
    }
    if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
      return html(false, 'invalid_state', 400, [clearedState]);
    }

    try {
      const tokens = await exchangeCodeForTokens(spec, fetchImpl, config, {
        code,
        redirectUri: redirectUriFor(spec, req.url),
      });
      if (!tokens.refresh_token) {
        // Google only returns a refresh token on first consent; `prompt=consent`
        // in the spec forces it. Surface a clear error if it's still missing.
        return html(false, 'no_refresh_token', 502, [clearedState]);
      }
      return html(true, 'ok', 200, [clearedState, cookie(REFRESH_COOKIE, tokens.refresh_token, REFRESH_MAX_AGE)]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'exchange_failed';
      console.error(`[${spec.id}] code exchange failed:`, message);
      return html(false, 'exchange_failed', 502, [clearedState]);
    }
  }

  async function token(req: Request): Promise<Response> {
    const cookies = parseCookies(req.headers.get('cookie'));
    const refreshToken = cookies[REFRESH_COOKIE];
    if (!refreshToken) {
      return json({ error: 'not_connected' }, 401);
    }
    try {
      const tokens = await refreshAccessToken(spec, fetchImpl, config, refreshToken);
      return json({
        access_token: tokens.access_token,
        expires_in: tokens.expires_in,
        account_id: tokens.account_id ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'refresh_failed';
      console.error(`[${spec.id}] token refresh failed:`, message);
      // Refresh token revoked/expired — clear it so the client re-connects.
      return json({ error: 'refresh_failed' }, 401, { 'Set-Cookie': cookie(REFRESH_COOKIE, '', 0) });
    }
  }

  async function disconnect(_req: Request): Promise<Response> {
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(REFRESH_COOKIE, '', 0) });
  }

  return { authStart, authCallback, token, disconnect };
}
