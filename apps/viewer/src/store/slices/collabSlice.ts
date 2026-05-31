/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collaboration slice (M1 scaffolding).
 *
 * Owns the live `CollabSession`, the local ephemeral identity, the resolved
 * access role, and the presence roster. This is the viewer-side counterpart
 * to `@ifc-lite/collab`; see `docs/architecture/essen-multiuser-collab-plan.md`
 * (§7.1) for the full M1 task list.
 *
 * What this scaffolding wires up today:
 *   - identity bootstrap (accountless, persisted handle + color),
 *   - session lifecycle (`startCollab` / `stopCollab`),
 *   - status + presence subscriptions feeding the store.
 *
 * What it deliberately stubs for later milestones (TODOs inline):
 *   - `seedFromStep` model seeding into the Y.Doc (plan §4.2, M1),
 *   - mutation binding + remote→local apply (plan §7.5, M2),
 *   - presence overlay mounting in the viewport (plan §7.4 — done at mount
 *     time in the viewport component, not here).
 */

import type { StateCreator } from 'zustand';
// IMPORTANT: only *type* imports from '@ifc-lite/collab' at module scope. The
// collab runtime (yjs, automerge, providers) is heavy and must stay out of the
// main bundle so the feature ships dark — it is lazy-imported inside
// `startCollab` and code-split into its own chunk.
import type {
  CollabSession,
  PresenceState,
  ProviderKind,
  StepSeedSource,
  UserIdentity,
  WebSocketStatus,
} from '@ifc-lite/collab';
import type { PropertyValueType } from '@ifc-lite/data';
import type { ViewerState } from '../index.js';
import { collabServerUrl } from '@/lib/collab/config';
import {
  loadOrCreateIdentity,
  persistIdentity,
  type EphemeralIdentity,
} from '@/lib/collab/identity';
import {
  attachRemoteApply,
  mirrorAttribute,
  mirrorProperty,
  mirrorPropertyDelete,
  pathForEntity,
  type CollabDocApi,
} from '@/lib/collab/mutation-bridge';
import {
  buildGeometryResultFromMeshes,
  hydrateGeometryFromRoom,
  seedGeometryToRoom,
  type CollabGeomApi,
} from '@/lib/collab/geometry-sync';
import { createSharedBlobStore } from '@/lib/collab/blob-store';

/**
 * Access roles, mirrored from `@ifc-lite/collab-server`'s `Role`. Kept as a
 * local type so the viewer doesn't depend on the server package. The role is
 * authoritative on the server (token-derived); the client value only gates
 * UI affordances.
 */
export type CollabRole = 'viewer' | 'commenter' | 'editor' | 'admin';

export type CollabStatus = 'disconnected' | WebSocketStatus | 'memory' | 'indexeddb';

export interface StartCollabOptions {
  /** Room to join. Owner-minted random id, or the `?room=` deep-link value. */
  roomId: string;
  /** Role this client believes it has (server re-checks via the token). */
  role: CollabRole;
  /** Bearer room token forwarded to the collab-server (plan §3.1). */
  token?: string;
  /**
   * Owner-only: lazily produce the model seed (plan §4.6 seed-into-room). Built
   * only when needed and applied only if the room's Y.Doc is still empty, so a
   * recipient joining a populated room hydrates from the doc instead of
   * re-seeding. Recipients (deep-link join) omit this.
   */
  seed?: () => StepSeedSource | null;
}

export interface CollabSlice {
  // ── State ────────────────────────────────────────────────────────────────
  /** The live session, or `null` when not in a shared room. */
  collabSession: CollabSession | null;
  /** Connection/persistence status surfaced for the toolbar indicator. */
  collabStatus: CollabStatus;
  /** Current room id, or `null`. */
  collabRoomId: string | null;
  /** This client's resolved role (UI gating only). */
  collabRole: CollabRole | null;
  /** Local ephemeral identity (handle + color). */
  collabIdentity: EphemeralIdentity;
  /** Remote peers currently present (excludes self). */
  collabPeers: PresenceState[];
  /** True while a session is being established. */
  collabConnecting: boolean;
  /** The room token this client joined with (admin for the owner). For minting + revoking links. */
  collabSelfToken: string | null;
  /** The most recently minted share link's token, so an admin can revoke it. */
  collabLastShareToken: string | null;

  // ── Actions ──────────────────────────────────────────────────────────────
  /** Rename / recolor the local identity and persist it. */
  setCollabIdentity: (patch: Partial<Pick<EphemeralIdentity, 'name' | 'color'>>) => void;
  /** Join (or create) a collaborative room. Idempotent: stops any prior session. */
  startCollab: (opts: StartCollabOptions) => Promise<void>;
  /** Leave the current room and tear everything down. */
  stopCollab: () => void;
  /** Record the latest minted share link token (for later revocation). */
  setCollabLastShareToken: (token: string | null) => void;
  /** Admin: invalidate the most recently minted share link. Returns success. */
  revokeCollabLink: () => Promise<boolean>;
  /** Admin: force-disconnect a peer by awareness clientId. Returns success. */
  kickPeer: (clientId: number) => Promise<boolean>;
  /** Whether this client may write the model (editor/admin). */
  canCollabEdit: () => boolean;
  /** Whether this client may write comments (commenter/editor/admin). */
  canCollabComment: () => boolean;

  // ── Mutation mirror (plan §7.5) — called by mutationSlice after a local
  //    edit. No-ops without an active session. ───────────────────────────────
  mirrorPropertyEdit: (
    entityId: number,
    psetName: string,
    propName: string,
    value: unknown,
    valueType: PropertyValueType,
  ) => void;
  mirrorPropertyDelete: (entityId: number, psetName: string, propName: string) => void;
  mirrorAttributeEdit: (entityId: number, attrName: string, value: unknown) => void;
}

function pickProvider(): ProviderKind {
  // With a server configured we run both local persistence and live sync;
  // without one we stay local-only (still multi-tab via BroadcastChannel),
  // which is enough to exercise the UI without a backend (plan §5 hosting).
  return collabServerUrl() ? 'indexeddb+websocket' : 'indexeddb';
}

function remotePeers(peers: Record<number, PresenceState>, selfClientId: number): PresenceState[] {
  const out: PresenceState[] = [];
  for (const [clientId, state] of Object.entries(peers)) {
    if (Number(clientId) === selfClientId) continue;
    // Annotate with the awareness clientId so admin actions (kick) can target it.
    out.push({ ...state, clientId: Number(clientId) } as PresenceState);
  }
  return out;
}

// Collab doc helpers captured from the lazy-loaded runtime (see startCollab),
// so the synchronous mutation mirror can write to the doc without re-importing.
let docApi: CollabDocApi | null = null;
// Teardown for the remote→local Y.Doc observer.
let remoteApplyTeardown: (() => void) | null = null;
// Teardown for the recipient's live re-reconstruction observer.
let recipientLiveTeardown: (() => void) | null = null;

export const createCollabSlice: StateCreator<ViewerState, [], [], CollabSlice> = (set, get) => ({
  // Initial state
  collabSession: null,
  collabStatus: 'disconnected',
  collabRoomId: null,
  collabRole: null,
  collabIdentity: loadOrCreateIdentity(),
  collabPeers: [],
  collabConnecting: false,
  collabSelfToken: null,
  collabLastShareToken: null,

  setCollabIdentity: (patch) => {
    const next: EphemeralIdentity = { ...get().collabIdentity, ...patch };
    persistIdentity(next);
    set({ collabIdentity: next });
    // Reflect the rename into a live session's presence immediately.
    const session = get().collabSession;
    if (session) {
      const user: UserIdentity = { id: next.id, name: next.name, color: next.color };
      session.presence.setUser(user);
    }
  },

  startCollab: async ({ roomId, role, token, seed }) => {
    // Tear down any existing session first (idempotent join).
    get().stopCollab();
    // Set the join token up front (not just at the end): setting collabRoomId
    // re-renders subscribers (e.g. ShareDialog) that immediately mint a
    // role-scoped share link, which needs our admin bearer to be available.
    set({ collabConnecting: true, collabRoomId: roomId, collabRole: role, collabSelfToken: token ?? null });

    const identity = get().collabIdentity;
    const user: UserIdentity = { id: identity.id, name: identity.name, color: identity.color };

    let session: CollabSession;
    let seedFromStep: typeof import('@ifc-lite/collab')['seedFromStep'];
    let collabMod: typeof import('@ifc-lite/collab');
    try {
      // Lazy-load the collab runtime (code-split) — see the import note above.
      const collab = await import('@ifc-lite/collab');
      collabMod = collab;
      seedFromStep = collab.seedFromStep;
      // Capture the doc helpers the synchronous mutation mirror needs.
      docApi = {
        hasEntity: collab.hasEntity,
        setPropertyValue: collab.setPropertyValue,
        deletePropertyValue: collab.deletePropertyValue,
        setAttribute: collab.setAttribute,
        PROPERTY_TYPE_NAMES: collab.PROPERTY_TYPE_NAMES,
      };
      session = await collab.createCollabSession({
        roomId,
        user,
        provider: pickProvider(),
        serverUrl: collabServerUrl() ?? undefined,
        token,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab] failed to start session:', err);
      set({ collabConnecting: false, collabStatus: 'disconnected' });
      return;
    }

    // If a newer start/stop happened while we were awaiting, discard.
    if (get().collabRoomId !== roomId) {
      session.dispose();
      return;
    }

    const selfClientId = session.clientId;
    session.presence.onUpdate((peers) => {
      set({ collabPeers: remotePeers(peers, selfClientId) });
    });
    session.onStatus((status) => set({ collabStatus: status }));
    // Broadcast our role so peers can show it in the roster (advisory; the
    // authoritative role is the server-verified token).
    try {
      session.presence.patch({ role });
    } catch {
      // presence may not accept the patch in older runtimes — non-fatal
    }

    const geomApi: CollabGeomApi = {
      createGeometry: (doc, geomId, opts) => collabMod.createGeometry(doc, geomId, opts),
      addGeometryRef: (doc, path, geomId) => collabMod.addGeometryRef(doc, path, geomId),
      getGeometryRef: (doc, path) => collabMod.getGeometryRef(doc, path),
      getGeometry: (doc, geomId) => collabMod.getGeometry(doc, geomId),
      iterEntities: (doc) => collabMod.iterEntities(doc),
    };

    // Owner seeds the model into the Y.Doc (plan §4.6 seed-into-room) once the
    // room has synced — but only if it's still empty, so we don't re-seed a
    // populated room or clobber a peer's edits. Recipients pass no `seed` and
    // hydrate from the doc instead.
    if (seed) {
      try {
        await session.whenSynced;
        if (get().collabRoomId === roomId && session.doc.getMap('entities').size === 0) {
          const source = seed();
          if (source) seedFromStep(session.doc, source);
          // Also seed tessellated geometry as blobs (plan §4.6, §7.9).
          const meshes = get().geometryResult?.meshes;
          const store = get().ifcDataStore;
          if (meshes && meshes.length > 0 && store) {
            const blobStore = await createSharedBlobStore(collabMod, collabServerUrl(), token);
            await seedGeometryToRoom(geomApi, session, blobStore, meshes, (id) =>
              pathForEntity(store, id),
            );
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] model seeding failed:', err);
      }
    } else {
      // Recipient (deep-link join, no local model): reconstruct the full model
      // from the CRDT as IFCX — the canonical format — then attach geometry
      // hydrated from the room's blobs. IFC5 rooms carry containment +
      // properties natively; legacy STEP rooms are seeded IFCX-shaped too (see
      // `buildStepSeedSource`), so this single path serves both. The renderer
      // and panels then use the standard legacy single-model path
      // (`ifcDataStore` + `geometryResult`). Best-effort — blobs may still be
      // syncing; a later re-join picks up the rest.
      try {
        await session.whenSynced;
        // Reconstruct the IfcDataStore (entities + spatial hierarchy +
        // properties) from the CRDT-as-IFCX via the viewer's existing importer.
        // Loaded lazily so the collab feature stays code-split.
        const { parseIfcxViewerModel } = await import('@/hooks/ingest/viewerModelIngest');
        const blobStore = await createSharedBlobStore(collabMod, collabServerUrl(), token);
        let lastGeomCount = -1;
        let reconstructing = false;

        // Re-derive the whole model from the doc. Cheap metadata refresh always;
        // geometry is re-hydrated from blobs only when the geometry set changed
        // (so a peer's property edit doesn't re-fetch every mesh).
        const reconstruct = async () => {
          if (reconstructing || get().collabRoomId !== roomId) return;
          reconstructing = true;
          try {
            const ifcxFile = collabMod.snapshotToIfcx(session.doc);
            const buffer = new TextEncoder().encode(JSON.stringify(ifcxFile)).buffer as ArrayBuffer;
            const payload = await parseIfcxViewerModel(buffer, undefined, { allowEmptyGeometry: true });
            if (get().collabRoomId !== roomId) return;
            get().setIfcDataStore(payload.dataStore);
            const geomCount = session.doc.getMap('geometry').size;
            if (geomCount !== lastGeomCount) {
              lastGeomCount = geomCount;
              // Re-key meshes into the reconstructed id space (pathToId) so 3D
              // selection resolves to the right inspector entry.
              const meshes = await hydrateGeometryFromRoom(geomApi, session, blobStore, payload.pathToId);
              if (get().collabRoomId === roomId) {
                get().setGeometryResult(
                  meshes.length > 0 ? buildGeometryResultFromMeshes(meshes) : payload.geometryResult,
                );
              }
            }
          } finally {
            reconstructing = false;
          }
        };

        // Initial build (only when we don't already have a local model).
        if (get().collabRoomId === roomId && !get().ifcDataStore) {
          await reconstruct();
        }

        // Live updates: re-reconstruct (debounced) whenever a peer edits the doc.
        let debounceHandle: ReturnType<typeof setTimeout> | null = null;
        const onDocUpdate = () => {
          if (debounceHandle) clearTimeout(debounceHandle);
          debounceHandle = setTimeout(() => {
            void reconstruct();
          }, 800);
        };
        session.doc.on('update', onDocUpdate);
        recipientLiveTeardown = () => {
          if (debounceHandle) clearTimeout(debounceHandle);
          try {
            session.doc.off('update', onDocUpdate);
          } catch {
            // ignore
          }
        };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] model reconstruction failed:', err);
      }
    }

    // Remote → local apply (plan §7.5): replay peers' property/attribute edits
    // into the active model's MutablePropertyView (no undo tracking, no echo).
    const applyStore = get().ifcDataStore;
    const applyModelId = get().activeModelId;
    if (applyStore && applyModelId) {
      remoteApplyTeardown = attachRemoteApply(session, applyStore, {
        onProperty: (entityId, pset, prop, value, type) => {
          const view = get().mutationViews.get(applyModelId);
          if (!view) return;
          view.setProperty(entityId, pset, prop, value, type);
          set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
        },
        onPropertyDelete: (entityId, pset, prop) => {
          const view = get().mutationViews.get(applyModelId);
          if (!view) return;
          view.deleteProperty(entityId, pset, prop);
          set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
        },
        onAttribute: (entityId, attrName, value) => {
          const view = get().mutationViews.get(applyModelId);
          if (!view) return;
          view.setAttribute(entityId, attrName, value === null ? '' : String(value));
          set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
        },
      });
    }

    set({
      collabSession: session,
      collabStatus: session.status(),
      collabConnecting: false,
      collabSelfToken: token ?? null,
    });
  },

  stopCollab: () => {
    if (remoteApplyTeardown) {
      try {
        remoteApplyTeardown();
      } catch {
        // ignore teardown errors
      }
      remoteApplyTeardown = null;
    }
    if (recipientLiveTeardown) {
      try {
        recipientLiveTeardown();
      } catch {
        // ignore teardown errors
      }
      recipientLiveTeardown = null;
    }
    docApi = null;
    const session = get().collabSession;
    if (session) {
      try {
        session.dispose();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] error disposing session:', err);
      }
    }
    set({
      collabSession: null,
      collabStatus: 'disconnected',
      collabRoomId: null,
      collabRole: null,
      collabPeers: [],
      collabConnecting: false,
      collabSelfToken: null,
      collabLastShareToken: null,
    });
  },

  setCollabLastShareToken: (token) => set({ collabLastShareToken: token }),

  revokeCollabLink: async () => {
    const shareToken = get().collabLastShareToken;
    const adminToken = get().collabSelfToken;
    if (!shareToken || !adminToken) return false;
    try {
      const { revokeRoomToken } = await import('@/lib/collab/share-link');
      return await revokeRoomToken(shareToken, adminToken);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab] revoke link failed:', err);
      return false;
    }
  },

  kickPeer: async (clientId) => {
    const roomId = get().collabRoomId;
    const adminToken = get().collabSelfToken;
    if (!roomId || !adminToken) return false;
    try {
      const { kickRoomPeer } = await import('@/lib/collab/share-link');
      return await kickRoomPeer(roomId, clientId, adminToken);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab] kick peer failed:', err);
      return false;
    }
  },

  canCollabEdit: () => {
    const role = get().collabRole;
    // Not in a shared room → fall back to the local single-user editing rules
    // (handled by the UI's existing `editEnabled` gate), so treat as allowed.
    if (role === null) return true;
    return role === 'editor' || role === 'admin';
  },

  canCollabComment: () => {
    const role = get().collabRole;
    if (role === null) return true;
    return role === 'commenter' || role === 'editor' || role === 'admin';
  },

  mirrorPropertyEdit: (entityId, psetName, propName, value, valueType) => {
    const session = get().collabSession;
    const store = get().ifcDataStore;
    if (!session || !store || !docApi) return;
    mirrorProperty(docApi, session, store, entityId, psetName, propName, value, valueType);
  },

  mirrorPropertyDelete: (entityId, psetName, propName) => {
    const session = get().collabSession;
    const store = get().ifcDataStore;
    if (!session || !store || !docApi) return;
    mirrorPropertyDelete(docApi, session, store, entityId, psetName, propName);
  },

  mirrorAttributeEdit: (entityId, attrName, value) => {
    const session = get().collabSession;
    const store = get().ifcDataStore;
    if (!session || !store || !docApi) return;
    mirrorAttribute(docApi, session, store, entityId, attrName, value);
  },
});
