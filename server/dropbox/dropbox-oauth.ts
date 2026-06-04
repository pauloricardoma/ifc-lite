/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure, side-effect-free helpers for the Dropbox OAuth 2.0 authorization-code
 * flow (confidential client + offline refresh token).
 *
 * The browser never sees the Dropbox app secret or the long-lived refresh
 * token — those stay server-side. The browser only ever receives a short-lived
 * access token (via `/api/dropbox/token`) which it uses to download IFC bytes
 * *directly* from Dropbox, so file contents never pass through our servers.
 *
 * This module is intentionally I/O-light: network calls take an injected
 * `fetchImpl` so the flow can be unit-tested without hitting Dropbox.
 */

export const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

/** Minimal scopes: list folders, read file content, read account display name. */
export const DROPBOX_SCOPES = [
  'account_info.read',
  'files.metadata.read',
  'files.content.read',
] as const;

/** Cookie that carries the CSRF state across the authorize round-trip. */
export const STATE_COOKIE = 'dbx_oauth_state';
/** Cookie that stores the long-lived refresh token (httpOnly, never read by JS). */
export const REFRESH_COOKIE = 'dbx_refresh';
/** Path the refresh cookie is scoped to — only sent to our Dropbox endpoints. */
export const REFRESH_COOKIE_PATH = '/api/dropbox';

export interface DropboxConfig {
  appKey: string;
  appSecret: string;
}

/**
 * Read Dropbox credentials from an environment bag. Returns `null` (rather than
 * throwing) when unconfigured so callers can degrade gracefully — a deploy
 * without Dropbox secrets simply reports "not configured" to the UI.
 */
export function loadDropboxConfig(
  env: Record<string, string | undefined>,
): DropboxConfig | null {
  const appKey = env.DROPBOX_APP_KEY?.trim();
  const appSecret = env.DROPBOX_APP_SECRET?.trim();
  if (!appKey || !appSecret) return null;
  return { appKey, appSecret };
}

export interface AuthorizeUrlParams {
  appKey: string;
  redirectUri: string;
  state: string;
}

/** Build the Dropbox consent-screen URL the user is sent to. */
export function buildAuthorizeUrl({ appKey, redirectUri, state }: AuthorizeUrlParams): string {
  const url = new URL(DROPBOX_AUTHORIZE_URL);
  url.searchParams.set('client_id', appKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  // `offline` is what makes Dropbox return a durable refresh token.
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('scope', DROPBOX_SCOPES.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

export interface DropboxTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
  account_id?: string;
  scope?: string;
}

async function postToken(
  fetchImpl: typeof fetch,
  config: DropboxConfig,
  body: Record<string, string>,
): Promise<DropboxTokenResponse> {
  const params = new URLSearchParams({
    ...body,
    client_id: config.appKey,
    client_secret: config.appSecret,
  });
  const res = await fetchImpl(DROPBOX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new DropboxTokenError(res.status, detail);
  }
  return (await res.json()) as DropboxTokenResponse;
}

/** Thrown when Dropbox rejects a token exchange/refresh; carries the HTTP status. */
export class DropboxTokenError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Dropbox token endpoint returned ${status}: ${detail}`);
    this.name = 'DropboxTokenError';
  }
}

/** Exchange a one-time authorization `code` for an access + refresh token pair. */
export function exchangeCodeForTokens(
  fetchImpl: typeof fetch,
  config: DropboxConfig,
  params: { code: string; redirectUri: string },
): Promise<DropboxTokenResponse> {
  return postToken(fetchImpl, config, {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
  });
}

/** Mint a fresh short-lived access token from a stored refresh token. */
export function refreshAccessToken(
  fetchImpl: typeof fetch,
  config: DropboxConfig,
  refreshToken: string,
): Promise<DropboxTokenResponse> {
  return postToken(fetchImpl, config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

// ── Cookie helpers ───────────────────────────────────────────────────────────

/** Parse a `Cookie` request header into a name→value map. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export interface CookieOptions {
  maxAge?: number; // seconds; omit for a session cookie, 0 to expire now
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

/** Serialize a single `Set-Cookie` value. */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${opts.path ?? '/'}`);
  if (opts.maxAge !== undefined) segments.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly) segments.push('HttpOnly');
  if (opts.secure) segments.push('Secure');
  segments.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  return segments.join('; ');
}

/** Cryptographically-random URL-safe state token for CSRF protection. */
export function randomState(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Derive the OAuth redirect URI for a given incoming request origin. */
export function redirectUriFor(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.origin}/api/dropbox/auth-callback`;
}
