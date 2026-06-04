/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Request handlers for the four Dropbox OAuth routes, built on the pure helpers
 * in `dropbox-oauth.ts`. Each handler is a `(Request) => Promise<Response>` so
 * it works in both the Vercel edge runtime and the local node dev server, and
 * can be exercised directly in unit tests.
 *
 *   GET  /api/dropbox/auth-start     → redirect to Dropbox consent screen
 *   GET  /api/dropbox/auth-callback  → exchange code, set refresh cookie, close popup
 *   POST /api/dropbox/token          → mint a short-lived access token from the cookie
 *   POST /api/dropbox/disconnect     → clear the refresh cookie
 */

import {
  type DropboxConfig,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  STATE_COOKIE,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  parseCookies,
  randomState,
  redirectUriFor,
  refreshAccessToken,
  serializeCookie,
} from './dropbox-oauth.js';

export interface DropboxHandlerDeps {
  config: DropboxConfig;
  fetchImpl?: typeof fetch;
  /** Override for tests; defaults to `randomState()`. */
  makeState?: () => string;
}

export interface DropboxHandlers {
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
 * the popup has visited dropbox.com.
 */
function popupResultHtml(ok: boolean, message: string): string {
  const payload = JSON.stringify({ ok, message, ts: Date.now() });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Dropbox</title></head>
<body style="font-family:system-ui;background:#0b0b0f;color:#e5e7eb;display:grid;place-items:center;height:100vh;margin:0">
<p>${ok ? 'Connected to Dropbox. You can close this window.' : `Dropbox connection failed: ${message}`}</p>
<script>
  try { localStorage.setItem('ifc-lite:dropbox:auth-result', ${JSON.stringify(payload)}); } catch (e) { console.error(e); }
  setTimeout(function () { try { window.close(); } catch (e) { /* user closes manually */ } }, ${ok ? 300 : 2500});
</script>
</body></html>`;
}

export function createDropboxHandlers(deps: DropboxHandlerDeps): DropboxHandlers {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const makeState = deps.makeState ?? (() => randomState());
  const { config } = deps;

  async function authStart(req: Request): Promise<Response> {
    const state = makeState();
    const redirectUri = redirectUriFor(req.url);
    const location = buildAuthorizeUrl({ appKey: config.appKey, redirectUri, state });
    return new Response(null, {
      status: 302,
      headers: {
        Location: location,
        'Set-Cookie': serializeCookie(STATE_COOKIE, state, {
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
          maxAge: STATE_MAX_AGE,
          path: REFRESH_COOKIE_PATH,
        }),
      },
    });
  }

  async function authCallback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');
    const cookies = parseCookies(req.headers.get('cookie'));
    const expectedState = cookies[STATE_COOKIE];

    const htmlHeaders = (cookie?: string): HeadersInit => {
      const h: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
      if (cookie) h['Set-Cookie'] = cookie;
      return h;
    };
    const clearedState = serializeCookie(STATE_COOKIE, '', {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 0,
      path: REFRESH_COOKIE_PATH,
    });

    if (oauthError) {
      return new Response(popupResultHtml(false, oauthError), { status: 400, headers: htmlHeaders(clearedState) });
    }
    if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
      return new Response(popupResultHtml(false, 'invalid_state'), { status: 400, headers: htmlHeaders(clearedState) });
    }

    try {
      const tokens = await exchangeCodeForTokens(fetchImpl, config, {
        code,
        redirectUri: redirectUriFor(req.url),
      });
      if (!tokens.refresh_token) {
        return new Response(popupResultHtml(false, 'no_refresh_token'), {
          status: 502,
          headers: htmlHeaders(clearedState),
        });
      }
      const setRefresh = serializeCookie(REFRESH_COOKIE, tokens.refresh_token, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: REFRESH_MAX_AGE,
        path: REFRESH_COOKIE_PATH,
      });
      // Two Set-Cookie headers: clear state, store refresh.
      const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
      headers.append('Set-Cookie', clearedState);
      headers.append('Set-Cookie', setRefresh);
      return new Response(popupResultHtml(true, 'ok'), { status: 200, headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'exchange_failed';
      console.error('[dropbox] code exchange failed:', message);
      return new Response(popupResultHtml(false, 'exchange_failed'), {
        status: 502,
        headers: htmlHeaders(clearedState),
      });
    }
  }

  async function token(req: Request): Promise<Response> {
    const cookies = parseCookies(req.headers.get('cookie'));
    const refreshToken = cookies[REFRESH_COOKIE];
    if (!refreshToken) {
      return json({ error: 'not_connected' }, 401);
    }
    try {
      const tokens = await refreshAccessToken(fetchImpl, config, refreshToken);
      return json({
        access_token: tokens.access_token,
        expires_in: tokens.expires_in,
        account_id: tokens.account_id ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'refresh_failed';
      console.error('[dropbox] token refresh failed:', message);
      // Refresh token revoked/expired — clear it so the client re-connects.
      const cleared = serializeCookie(REFRESH_COOKIE, '', {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: 0,
        path: REFRESH_COOKIE_PATH,
      });
      return json({ error: 'refresh_failed' }, 401, { 'Set-Cookie': cleared });
    }
  }

  async function disconnect(_req: Request): Promise<Response> {
    const cleared = serializeCookie(REFRESH_COOKIE, '', {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 0,
      path: REFRESH_COOKIE_PATH,
    });
    return json({ ok: true }, 200, { 'Set-Cookie': cleared });
  }

  return { authStart, authCallback, token, disconnect };
}
