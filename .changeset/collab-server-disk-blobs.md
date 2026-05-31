---
"@ifc-lite/collab-server": minor
---

Disk-backed blob storage + durable access control.

- New `FsBlobStorage` (one file per content-addressed blob under
  `COLLAB_DATA_DIR`), wired as the `bin.ts` default in place of the in-memory
  store — cuts the memory footprint and survives restarts on a mounted volume.
- The revocation deny-list and first-touch room-claim set are now persisted to
  `<dataDir>/access-control.json`, and `POST /collab/token` rejects a revoked
  bearer — so revocations survive restarts and a restart can't be used to take
  over an already-claimed room.
