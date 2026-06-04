# Cloud Import (Dropbox)

Load IFC files straight from a cloud storage account instead of downloading
them to disk first. The first provider is **Dropbox**; the design is
provider-agnostic so Google Drive and OneDrive/SharePoint can follow.

## How it works

```
Browser ──"Connect"──▶ /api/dropbox/auth-start ──▶ Dropbox consent (popup)
       ◀── refresh-token cookie (httpOnly) ── /api/dropbox/auth-callback
Browser ──POST──▶ /api/dropbox/token ──▶ short-lived access token (in memory)
Browser ──Bearer token──▶ Dropbox API  (list folders, download bytes)
       └─ downloaded File ─▶ existing addModel()/loadFile() pipeline
```

Two properties are deliberate:

- **Privacy preserved.** IFC bytes stream **directly from Dropbox to the
  browser**. They never pass through ifclite servers — only the OAuth token
  exchange does. This matches the app's local-first posture (see
  [Privacy](privacy.md)).
- **Connection remembered.** The Dropbox app secret and the long-lived
  *refresh token* stay server-side in an `httpOnly`, `Secure`, `SameSite=Lax`
  cookie scoped to `/api/dropbox`. The browser only ever holds a short-lived
  access token in memory, refreshed on demand. JavaScript can never read the
  refresh token, so an XSS bug can't exfiltrate the long-term credential.

The consent popup signals success back to the app via a same-origin
`localStorage` write (the `storage` event) rather than
`window.opener.postMessage`, because the app sets
`Cross-Origin-Opener-Policy: same-origin` (needed for `SharedArrayBuffer`),
which severs `window.opener` after the cross-origin Dropbox hop.

## Code layout

| Concern | Location |
| --- | --- |
| Pure OAuth helpers (URLs, token exchange, cookies) | `server/dropbox/dropbox-oauth.ts` |
| Route handlers (testable) | `server/dropbox/dropbox-handlers.ts` |
| Vercel edge endpoints | `api/dropbox/{auth-start,auth-callback,token,disconnect}.ts` |
| Provider abstraction | `apps/viewer/src/services/cloud/types.ts` |
| Dropbox browser client | `apps/viewer/src/services/cloud/dropbox.ts` |
| Importer UI | `apps/viewer/src/components/viewer/cloud/CloudImportDialog.tsx` |
| Tests | `tests/api/dropbox.test.ts` |

## Deployment setup

Cloud import is **disabled unless configured** — each `/api/dropbox/*` route
returns `501 dropbox_not_configured` when the secrets are absent, and the UI
surfaces a clear connect error.

1. Create a Dropbox app at <https://www.dropbox.com/developers/apps>
   (*Scoped access* → *Full Dropbox* or *App folder*).
2. Grant the scopes: `account_info.read`, `files.metadata.read`,
   `files.content.read`.
3. Add the OAuth redirect URI for every origin you deploy to, e.g.
   `https://ifclite.com/api/dropbox/auth-callback` (and your preview/localhost
   origins).
4. Set the following environment variables on the deployment:

   | Variable | Value |
   | --- | --- |
   | `DROPBOX_APP_KEY` | Dropbox app key |
   | `DROPBOX_APP_SECRET` | Dropbox app secret |

No client-side env vars are needed — the browser only talks to `/api/dropbox/*`.

## Testing

```bash
pnpm test:api    # runs tests/api/**, including dropbox.test.ts
```

The handler tests inject a stub `fetch`, so they cover URL building, the CSRF
state round-trip, code exchange, token refresh, cookie clearing on revocation,
and disconnect — without contacting Dropbox.

## Roadmap

- **Google Drive** — Picker API + Google Identity Services (PKCE).
- **OneDrive / SharePoint** — Microsoft Graph + MSAL (Azure AD app
  registration; enterprise tenants may require admin consent).
- **Proton Drive** — blocked on Proton shipping third-party auth for their
  Drive SDK (targeted late 2026 / early 2027). Until then the practical path is
  reading a Proton Drive *desktop-sync folder* via the Tauri desktop build.
