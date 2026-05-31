---
"@ifc-lite/collab-server": minor
---

Add CORS support to the HTTP routes (`/blobs`, `/healthz`, `/metrics`, and the
`/collab/token` mint route). The viewer is served from a different origin than
the collab-server, so a browser `PUT`/`GET` to the content-addressed blob route
needs `Access-Control-Allow-*` headers and an `OPTIONS` preflight response —
without them the WebSocket doc still syncs but geometry blobs are blocked, so a
recipient joining a seed-into-room link gets the entity list with no meshes.
`startCollabServer` now answers preflights and sets `Access-Control-Allow-Origin`
(plus `Cross-Origin-Resource-Policy: cross-origin` so the bytes are readable from
a COEP-isolated page). The new `cors` option reflects the request origin by
default, accepts an explicit allow-list to restrict, or `false` to disable when a
reverse proxy owns CORS.
