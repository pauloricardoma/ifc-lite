/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  loadDropboxConfig,
  parseCookies,
  redirectUriFor,
  refreshAccessToken,
  serializeCookie,
  DropboxTokenError,
  REFRESH_COOKIE,
  STATE_COOKIE,
} from '../../server/dropbox/dropbox-oauth.js';
import { createDropboxHandlers } from '../../server/dropbox/dropbox-handlers.js';

const CONFIG = { appKey: 'app-key', appSecret: 'app-secret' };

/** A fetch stub that returns a queued response and records the call. */
function stubFetch(responses: Response[]): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const res = responses[i++];
    if (!res) throw new Error('stubFetch: no more responses queued');
    return res;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('loadDropboxConfig returns null when unconfigured', () => {
  assert.equal(loadDropboxConfig({}), null);
  assert.equal(loadDropboxConfig({ DROPBOX_APP_KEY: 'k' }), null);
  assert.deepEqual(loadDropboxConfig({ DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's' }), {
    appKey: 'k',
    appSecret: 's',
  });
});

test('buildAuthorizeUrl includes offline access and scopes', () => {
  const url = new URL(buildAuthorizeUrl({ appKey: 'k', redirectUri: 'https://app/api/dropbox/auth-callback', state: 'st' }));
  assert.equal(url.origin + url.pathname, 'https://www.dropbox.com/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), 'k');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('token_access_type'), 'offline');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app/api/dropbox/auth-callback');
  assert.match(url.searchParams.get('scope') ?? '', /files\.content\.read/);
});

test('redirectUriFor derives the callback from the request origin', () => {
  assert.equal(redirectUriFor('https://ifclite.com/api/dropbox/auth-start'), 'https://ifclite.com/api/dropbox/auth-callback');
});

test('cookie parse/serialize round-trips and respects options', () => {
  const cookie = serializeCookie('foo', 'a b/c', { httpOnly: true, secure: true, maxAge: 60, path: '/x', sameSite: 'Lax' });
  assert.match(cookie, /^foo=a%20b%2Fc/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=60/);
  assert.match(cookie, /Path=\/x/);
  assert.match(cookie, /SameSite=Lax/);

  const parsed = parseCookies('foo=a%20b%2Fc; bar=baz');
  assert.equal(parsed.foo, 'a b/c');
  assert.equal(parsed.bar, 'baz');
});

test('exchangeCodeForTokens posts the right grant and parses tokens', async () => {
  const { fetch: f, calls } = stubFetch([tokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 14400, token_type: 'bearer' })]);
  const tokens = await exchangeCodeForTokens(f, CONFIG, { code: 'code123', redirectUri: 'https://app/cb' });
  assert.equal(tokens.access_token, 'at');
  assert.equal(tokens.refresh_token, 'rt');
  const body = String((calls[0].init?.body) ?? '');
  assert.match(body, /grant_type=authorization_code/);
  assert.match(body, /code=code123/);
  assert.match(body, /client_secret=app-secret/);
});

test('refreshAccessToken throws DropboxTokenError on failure', async () => {
  const { fetch: f } = stubFetch([tokenResponse({ error: 'invalid_grant' }, 400)]);
  await assert.rejects(() => refreshAccessToken(f, CONFIG, 'rt'), (err: unknown) => {
    assert.ok(err instanceof DropboxTokenError);
    assert.equal(err.status, 400);
    return true;
  });
});

// ── Handlers ────────────────────────────────────────────────────────────────

test('authStart redirects to Dropbox and sets a state cookie', async () => {
  const handlers = createDropboxHandlers({ config: CONFIG, makeState: () => 'STATE123', fetchImpl: stubFetch([]).fetch });
  const res = await handlers.authStart(new Request('https://ifclite.com/api/dropbox/auth-start'));
  assert.equal(res.status, 302);
  const location = res.headers.get('Location') ?? '';
  assert.match(location, /dropbox\.com\/oauth2\/authorize/);
  assert.match(location, /state=STATE123/);
  const setCookie = res.headers.get('Set-Cookie') ?? '';
  assert.match(setCookie, new RegExp(`${STATE_COOKIE}=STATE123`));
  assert.match(setCookie, /HttpOnly/);
});

test('authCallback rejects a mismatched state', async () => {
  const handlers = createDropboxHandlers({ config: CONFIG, fetchImpl: stubFetch([]).fetch });
  const req = new Request('https://ifclite.com/api/dropbox/auth-callback?code=c&state=evil', {
    headers: { cookie: `${STATE_COOKIE}=expected` },
  });
  const res = await handlers.authCallback(req);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /invalid_state/);
});

test('authCallback exchanges code and stores the refresh cookie', async () => {
  const { fetch: f } = stubFetch([tokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 14400, token_type: 'bearer' })]);
  const handlers = createDropboxHandlers({ config: CONFIG, fetchImpl: f });
  const req = new Request('https://ifclite.com/api/dropbox/auth-callback?code=c&state=ok', {
    headers: { cookie: `${STATE_COOKIE}=ok` },
  });
  const res = await handlers.authCallback(req);
  assert.equal(res.status, 200);
  const cookies = res.headers.getSetCookie();
  assert.ok(cookies.some((c) => new RegExp(`${REFRESH_COOKIE}=rt`).test(c) && /HttpOnly/.test(c)));
  assert.ok(cookies.some((c) => new RegExp(`${STATE_COOKIE}=;|${STATE_COOKIE}=$`).test(c) || /Max-Age=0/.test(c)));
  assert.match(await res.text(), /auth-result/); // popup signalling script present
});

test('token returns 401 when no refresh cookie is present', async () => {
  const handlers = createDropboxHandlers({ config: CONFIG, fetchImpl: stubFetch([]).fetch });
  const res = await handlers.token(new Request('https://ifclite.com/api/dropbox/token', { method: 'POST' }));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'not_connected' });
});

test('token mints an access token from the refresh cookie', async () => {
  const { fetch: f } = stubFetch([tokenResponse({ access_token: 'fresh', expires_in: 14400, token_type: 'bearer', account_id: 'acc' })]);
  const handlers = createDropboxHandlers({ config: CONFIG, fetchImpl: f });
  const req = new Request('https://ifclite.com/api/dropbox/token', { method: 'POST', headers: { cookie: `${REFRESH_COOKIE}=rt` } });
  const res = await handlers.token(req);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { access_token: 'fresh', expires_in: 14400, account_id: 'acc' });
});

test('token clears the cookie when the refresh token is rejected', async () => {
  const { fetch: f } = stubFetch([tokenResponse({ error: 'invalid_grant' }, 400)]);
  const handlers = createDropboxHandlers({ config: CONFIG, fetchImpl: f });
  const req = new Request('https://ifclite.com/api/dropbox/token', { method: 'POST', headers: { cookie: `${REFRESH_COOKIE}=stale` } });
  const res = await handlers.token(req);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('Set-Cookie') ?? '', /Max-Age=0/);
});

test('disconnect clears the refresh cookie', async () => {
  const handlers = createDropboxHandlers({ config: CONFIG, fetchImpl: stubFetch([]).fetch });
  const res = await handlers.disconnect(new Request('https://ifclite.com/api/dropbox/disconnect', { method: 'POST' }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Set-Cookie') ?? '', new RegExp(`${REFRESH_COOKIE}=`));
  assert.match(res.headers.get('Set-Cookie') ?? '', /Max-Age=0/);
});
