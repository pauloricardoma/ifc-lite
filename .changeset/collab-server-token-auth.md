---
"@ifc-lite/collab-server": minor
---

Enable accountless, link-based access control end to end. Setting
`COLLAB_TOKEN_SECRET` switches the CLI server from anonymous-editor to
room-token auth: joins require a valid signed token, the first token minted for
a brand-new room makes its requester `admin` (first-touch creator), and only an
admin token for that room may mint further role-scoped links. Adds a
`POST /collab/revoke` route (and a `revokeEndpoint` option) so an admin can
invalidate a share link by `jti` — future joins with it are rejected. Without
`COLLAB_TOKEN_SECRET` the server stays anonymous (unchanged) for local/dev use.
