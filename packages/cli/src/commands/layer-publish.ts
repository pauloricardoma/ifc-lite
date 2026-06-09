/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite layer publish|create|status` — publish a delta document as a
 * content-addressed layer, with publish-time scope verification
 * (07-security.md §7.2), plus the draft descriptor workflow.
 */

import type { AuthorKind, IfcxFile, ProvenanceBase } from '@ifc-lite/ifcx';
import {
  ATTR,
  IFCLITE_ATTR,
  computeLayerId,
  computeStackHash,
  createProvenanceManifest,
  setProvenance,
} from '@ifc-lite/ifcx';
import { extractStackState, type EntityState } from '@ifc-lite/merge';
import { findCoveringClaim, parseScopeClaims } from '@ifc-lite/extensions';
import { getAllFlags, getFlag, hasFlag, printJson } from '../output.js';
import {
  deleteDraft,
  defaultPrincipal,
  loadRefLayers,
  readDraft,
  readIfcxFile,
  refStackHash,
  requireRef,
  storeFromArgs,
  storeLayer,
  writeDraft,
  type LayerStore,
} from './layer-store.js';

const PSET_QTO_RE = /(?:^|::)((?:Pset|Qto)_[A-Za-z0-9_]+)(?:::|$)/;
const AUTHOR_KINDS: readonly AuthorKind[] = ['human', 'agent', 'hybrid'];

/** A derived op descriptor with the entity path kept for diagnostics. */
export interface DerivedScopeOp {
  path: string;
  capability: string;
  ifcType?: string;
}

function classCodeOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function ifcTypeFor(node: IfcxFile['data'][number], baseEntity: EntityState | undefined): string | undefined {
  const baseClass = baseEntity?.components.get('attr:class');
  return classCodeOf(baseClass?.[ATTR.CLASS]) ?? classCodeOf(node.attributes?.[ATTR.CLASS]);
}

/**
 * Derive op descriptors from a delta's nodes against the base state:
 * tombstones → `model.delete`, new entities → `model.create`, everything
 * else `model.mutate:<target>` per attribute (target = Pset/Qto name when
 * present in the key, else the last `::` segment).
 */
export function deriveScopeOps(delta: IfcxFile, baseLayers: readonly IfcxFile[]): DerivedScopeOp[] {
  const baseState = extractStackState(baseLayers);
  const ops: DerivedScopeOp[] = [];

  for (const node of delta.data) {
    const baseEntity = baseState.get(node.path);
    const ifcType = ifcTypeFor(node, baseEntity);
    const push = (capability: string): void => {
      const op: DerivedScopeOp = { path: node.path, capability };
      if (ifcType !== undefined) op.ifcType = ifcType;
      ops.push(op);
    };

    if (node.attributes?.[IFCLITE_ATTR.DELETED] === true) {
      push('model.delete');
      continue;
    }
    if (baseEntity === undefined || baseEntity.deleted) {
      push('model.create');
      continue;
    }
    for (const key of Object.keys(node.attributes ?? {})) {
      if (key === IFCLITE_ATTR.DELETED || key.startsWith(IFCLITE_ATTR.DERIVED)) continue;
      const setMatch = PSET_QTO_RE.exec(key);
      const target = setMatch ? setMatch[1] : key.split('::').pop() ?? key;
      push(`model.mutate:${target}`);
    }
  }
  return ops;
}

export interface ScopeVerification {
  verified: boolean;
  violations: DerivedScopeOp[];
}

/**
 * Verify derived ops against declared claims. An empty claim list skips
 * verification (claims are optional); parse errors throw.
 */
export function verifyScopeClaims(
  claims: readonly string[],
  ops: readonly DerivedScopeOp[]
): ScopeVerification {
  if (claims.length === 0) return { verified: true, violations: [] };
  const parsed = parseScopeClaims(claims);
  if (!parsed.ok) {
    const detail = parsed.errors.map((e) => e.message).join('; ');
    throw new Error(`Invalid scope claim(s): ${detail}`);
  }
  const violations = ops.filter((op) => findCoveringClaim(parsed.value, op) === undefined);
  return { verified: violations.length === 0, violations };
}

export interface PublishInit {
  delta: IfcxFile;
  /** Base ref name; null when published against nothing ('-'). */
  baseRef: string | null;
  intent: string;
  scope?: string[];
  principal?: string;
  kind?: AuthorKind;
  created?: string;
}

export interface PublishResult {
  layerId: string;
  file: IfcxFile;
  opCount: number;
  scopeVerified: boolean;
  violations: DerivedScopeOp[];
}

/** Build provenance, content-address, scope-verify and store a delta. */
export function publishLayer(store: LayerStore, init: PublishInit): PublishResult {
  const baseLayers = init.baseRef === null ? [] : loadRefLayers(store, init.baseRef);
  const base: ProvenanceBase | null =
    init.baseRef === null
      ? null
      : { kind: 'stack', id: computeStackHash(requireRef(store, init.baseRef).layers) };

  const scope = init.scope ?? [];
  const manifest = createProvenanceManifest({
    author: { kind: init.kind ?? 'human', principal: init.principal ?? defaultPrincipal() },
    intent: init.intent,
    base,
    created: init.created,
    scope_claim: scope,
  });
  const withManifest = setProvenance(init.delta, manifest);
  const layerId = computeLayerId(withManifest);
  const file: IfcxFile = { ...withManifest, header: { ...withManifest.header, id: layerId } };

  const ops = deriveScopeOps(init.delta, baseLayers);
  const { verified, violations } = verifyScopeClaims(scope, ops);

  storeLayer(store, file);
  return { layerId, file, opCount: ops.length, scopeVerified: verified, violations };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function parseKind(raw: string | undefined): AuthorKind {
  if (raw === undefined) return 'human';
  if ((AUTHOR_KINDS as readonly string[]).includes(raw)) return raw as AuthorKind;
  throw new Error(`--kind must be one of ${AUTHOR_KINDS.join(' | ')}, got "${raw}"`);
}

export async function layerPublishCommand(args: string[]): Promise<void> {
  const store = storeFromArgs(args);
  const deltaPath = args[0];
  if (!deltaPath || deltaPath.startsWith('-')) {
    throw new Error(
      'Usage: ifc-lite layer publish <delta.ifcx> --base <ref|-> --intent "<text>" [--scope <claim>]... [--principal <id>] [--kind human|agent|hybrid] [--strict-scope] [--json]'
    );
  }

  const draft = readDraft(store);
  const baseFlag = getFlag(args, '--base') ?? draft?.base;
  if (baseFlag === undefined) {
    throw new Error('Missing --base <ref|-> (no draft.json to default from)');
  }
  const intent = getFlag(args, '--intent') ?? draft?.intent;
  if (intent === undefined) {
    throw new Error('Missing --intent (no draft.json to default from)');
  }
  const scopeFlags = getAllFlags(args, '--scope');
  const scope = scopeFlags.length > 0 ? scopeFlags : draft?.scope ?? [];

  const result = publishLayer(store, {
    delta: readIfcxFile(deltaPath),
    baseRef: baseFlag === '-' ? null : baseFlag,
    intent,
    scope,
    principal: getFlag(args, '--principal'),
    kind: parseKind(getFlag(args, '--kind')),
  });

  if (!result.scopeVerified) {
    process.stderr.write('Warning: scope claim mismatch — ops outside the declared claims:\n');
    for (const op of result.violations) {
      const type = op.ifcType ? ` (${op.ifcType})` : '';
      process.stderr.write(`  ${op.path}: ${op.capability}${type}\n`);
    }
  }

  if (draft) deleteDraft(store);

  if (hasFlag(args, '--json')) {
    printJson({ id: result.layerId, opCount: result.opCount, scope_verified: result.scopeVerified });
  } else {
    process.stdout.write(`${result.layerId}\n`);
    process.stderr.write(`Published ${result.opCount} op(s) to ${store.dir}\n`);
  }

  if (!result.scopeVerified && hasFlag(args, '--strict-scope')) {
    process.exit(4);
  }
}

export async function layerCreateCommand(args: string[]): Promise<void> {
  const store = storeFromArgs(args);
  const baseRef = getFlag(args, '--base');
  const intent = getFlag(args, '--intent');
  if (!baseRef || !intent) {
    throw new Error('Usage: ifc-lite layer create --base <ref> --intent "<text>" [--scope <claim>]...');
  }
  const draft = {
    base: baseRef,
    baseStackHash: baseRef === '-' ? computeStackHash([]) : refStackHash(store, baseRef),
    intent,
    scope: getAllFlags(args, '--scope'),
    created: new Date().toISOString(),
  };
  writeDraft(store, draft);
  if (hasFlag(args, '--json')) printJson(draft);
  else process.stderr.write(`Draft recorded at ${store.dir}/draft.json (base ${baseRef})\n`);
}

export async function layerStatusCommand(args: string[]): Promise<void> {
  const store = storeFromArgs(args);
  const draft = readDraft(store);
  if (!draft) {
    process.stderr.write(`No draft in ${store.dir} — run 'ifc-lite layer create' first.\n`);
    process.exit(1);
  }
  const currentHash = draft.base === '-' ? computeStackHash([]) : refStackHash(store, draft.base);
  const baseMoved = currentHash !== draft.baseStackHash;
  if (hasFlag(args, '--json')) {
    printJson({ ...draft, baseMoved, currentBaseStackHash: currentHash });
    return;
  }
  process.stdout.write(`base:    ${draft.base}\n`);
  process.stdout.write(`intent:  ${draft.intent}\n`);
  process.stdout.write(`scope:   ${draft.scope.length > 0 ? draft.scope.join(', ') : '(none)'}\n`);
  process.stdout.write(`created: ${draft.created}\n`);
  process.stdout.write(
    baseMoved
      ? `base ref has MOVED since the draft was created (${draft.baseStackHash} → ${currentHash})\n`
      : 'base ref has not moved\n'
  );
}
