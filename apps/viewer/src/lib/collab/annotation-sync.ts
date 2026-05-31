/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Annotation sync bridge (collab markup).
 *
 *   local create/edit/delete ─▶ annotationsSlice ─▶ mirrorAnnotation*() ─▶
 *       session.transact(createAnnotation / deleteAnnotation)  (y-websocket)
 *   peer's annotations Y.Map update ─▶ observeDeep (txn.local=false) ─▶
 *       upsert/remove into the slice (marked `remote`, never re-mirrored)
 *
 * Mirrors the property mutation-bridge: the slice invokes the mirror
 * imperatively (so only genuine local edits go out) and inbound applies via the
 * slice's `remote` setters (which never mirror) — so edits can't echo. Annotations
 * are position-anchored (entityPath reserved for a later entity-anchor pass).
 * The collab runtime is injected (never eager-imported here).
 */

import type { CollabSession } from '@ifc-lite/collab';
import type { Annotation } from '@/store/slices/annotationsSlice';

/** Wire shape stored in the CRDT (see packages/collab `doc/annotation.ts`). */
export interface CrdtAnnotationFields {
  position: { x: number; y: number; z: number };
  note: string;
  entityPath?: string | null;
  authorId: string;
  authorName: string;
  authorColor: string;
  createdAt: number;
  updatedAt: number;
}
export interface CrdtAnnotationRecord extends CrdtAnnotationFields {
  id: string;
}

/** Minimal observable Y.Map surface (avoids a direct yjs dep in the viewer). */
interface ObservableMap {
  observeDeep(fn: (events: unknown, txn: { local?: boolean }) => void): void;
  unobserveDeep(fn: (events: unknown, txn: { local?: boolean }) => void): void;
}

/** The CRDT annotation helpers this bridge needs (injected from the collab module). */
export interface AnnotationDocApi {
  annotationsMap(doc: CollabSession['doc']): ObservableMap;
  createAnnotation(doc: CollabSession['doc'], id: string, fields: CrdtAnnotationFields): unknown;
  deleteAnnotation(doc: CollabSession['doc'], id: string): boolean;
  iterAnnotations(doc: CollabSession['doc']): IterableIterator<CrdtAnnotationRecord>;
}

/** Local annotation → CRDT fields. v1 anchors by world position (entityPath null). */
export function annotationToCrdtFields(a: Annotation): CrdtAnnotationFields {
  return {
    position: { x: a.position.x, y: a.position.y, z: a.position.z },
    note: a.note,
    entityPath: null,
    authorId: a.authorId ?? '',
    authorName: a.authorName ?? '',
    authorColor: a.authorColor ?? '',
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function recordToAnnotation(r: CrdtAnnotationRecord): Annotation {
  return {
    id: r.id,
    position: { x: r.position.x, y: r.position.y, z: r.position.z },
    note: r.note,
    entityExpressId: null,
    modelId: null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    authorId: r.authorId || undefined,
    authorName: r.authorName || undefined,
    authorColor: r.authorColor || undefined,
    remote: true,
  };
}

export interface AnnotationInboundCtx {
  /** Current local annotation map (to avoid clobbering our own authored pins). */
  getLocal(): Map<string, Annotation>;
  upsertRemote(a: Annotation): void;
  removeRemote(id: string): void;
}

/**
 * Observe the room's annotations and reflect peers' pins into the local slice.
 * Skips our own writes (`txn.local`) and never overwrites a locally-authored pin
 * with its echo. Does an initial pull so a late joiner sees existing pins.
 * Returns a teardown.
 */
export function attachAnnotationInbound(
  session: CollabSession,
  api: AnnotationDocApi,
  ctx: AnnotationInboundCtx,
): () => void {
  const doc = session.doc;
  const map = api.annotationsMap(doc);

  const apply = (isLocalTxn: boolean) => {
    if (isLocalTxn) return; // our own mirror writes — ignore
    const remote = new Map<string, CrdtAnnotationRecord>();
    for (const r of api.iterAnnotations(doc)) remote.set(r.id, r);
    const local = ctx.getLocal();
    for (const r of remote.values()) {
      const existing = local.get(r.id);
      // A locally-authored pin (not `remote`) is the source of truth for its own
      // id — don't reflect its echo back as a remote copy.
      if (existing && !existing.remote) continue;
      ctx.upsertRemote(recordToAnnotation(r));
    }
    for (const [id, a] of local) {
      if (a.remote && !remote.has(id)) ctx.removeRemote(id);
    }
  };

  const onChange = (_events: unknown, txn: { local?: boolean }) => apply(Boolean(txn?.local));
  map.observeDeep(onChange);
  apply(false); // initial pull of pins already in the room
  return () => map.unobserveDeep(onChange);
}
