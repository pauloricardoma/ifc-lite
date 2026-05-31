---
"@ifc-lite/collab-server": minor
---

Add an admin "kick" route: `POST /collab/kick` (enabled via the `kickEndpoint`
option) force-disconnects a peer by awareness clientId. It also revokes the
kicked peer's token `jti` (when a revoke endpoint is configured) so the client's
y-websocket can't immediately reconnect with the same link. `RoomManager.peek`
and `Room.kickClient` expose the underlying capability.
