/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite layer merge <layer-id> --into <ref>` — the layer-PR merge
 * flow: fast-forward when the candidate was authored against the ref's
 * current stack, otherwise a three-way plan with explicit conflicts,
 * blanket resolutions (--resolve ours|theirs), and ref-policy
 * enforcement (required checks, human approval) before completion.
 *
 * Exit codes (09 §9.3): 0 clean, 2 conflicts, 3 policy failure.
 */

import type { IfcxFile, ProvenanceBase, ProvenanceManifest, WaivedCheck } from '@ifc-lite/ifcx';
import { computeStackHash, getProvenance } from '@ifc-lite/ifcx';
import {
  applyResolutions,
  buildMergeLayer,
  planThreeWayMerge,
  type MergeConflict,
  type MergePlan,
  type ResolutionInput,
} from '@ifc-lite/merge';
import { getAllFlags, getFlag, hasFlag, printJson } from '../output.js';
import {
  defaultPrincipal,
  loadLayer,
  requireRef,
  resolveLayerId,
  setRef,
  shortId,
  storeFromArgs,
  storeLayer,
  type LayerStore,
  type RefEntry,
} from './layer-store.js';

export interface AncestorResolution {
  /** Ordered layer documents forming the ancestor stack. */
  layers: IfcxFile[];
  /** Layer ids forming the ancestor stack. */
  ids: string[];
  /** False when manifest.base was null or matched no prefix of the ref. */
  matched: boolean;
}

/**
 * Resolve a candidate's `manifest.base` to a prefix of the ref's layer
 * list: a stack base matches the prefix with the same stack hash, a layer
 * base matches the prefix ending at that layer id.
 */
export function resolveAncestor(
  store: LayerStore,
  refLayerIds: readonly string[],
  base: ProvenanceBase | null | undefined
): AncestorResolution {
  const load = (ids: readonly string[]): IfcxFile[] => ids.map((id) => loadLayer(store, id));
  // Null/missing base: ancestor is the empty stack ("warn" case in 09).
  if (base == null) return { layers: [], ids: [], matched: false };

  if (base.kind === 'layer') {
    const idx = refLayerIds.indexOf(base.id);
    if (idx !== -1) {
      const ids = refLayerIds.slice(0, idx + 1);
      return { layers: load(ids), ids: [...ids], matched: true };
    }
    return { layers: [], ids: [], matched: false };
  }

  for (let i = 0; i <= refLayerIds.length; i++) {
    const prefix = refLayerIds.slice(0, i);
    if (computeStackHash(prefix) === base.id) {
      return { layers: load(prefix), ids: [...prefix], matched: true };
    }
  }
  return { layers: [], ids: [], matched: false };
}

export interface Waiver {
  spec: string;
  reason: string;
}

/** Returns a failure message when the ref's policy blocks completion. */
export function checkRefPolicy(
  entry: RefEntry,
  manifest: ProvenanceManifest | undefined,
  waivers: readonly Waiver[],
  approvedBy: string | undefined
): string | undefined {
  const policy = entry.policy;
  if (!policy) return undefined;

  const waived = new Set(waivers.map((w) => w.spec));
  for (const spec of policy.requiredChecks ?? []) {
    if (waived.has(spec)) continue;
    const passing = (manifest?.checks ?? []).some((c) => c.spec === spec && c.result === 'pass');
    if (!passing) {
      return `required check "${spec}" did not pass on the candidate (waive with --waive "${spec}" --reason "...")`;
    }
  }
  if (policy.requireHumanApproval && manifest?.author.kind === 'agent' && approvedBy === undefined) {
    return 'ref requires human approval for agent-authored layers (pass --approved-by <principal>)';
  }
  return undefined;
}

export interface MergeInit {
  candidateId: string;
  into: string;
  preview?: boolean;
  resolve?: 'ours' | 'theirs';
  waivers?: Waiver[];
  approvedBy?: string;
  principal?: string;
  created?: string;
}

export type MergeOutcome =
  | { status: 'fast-forward'; refLayers: string[]; ancestorMatched: true }
  | { status: 'preview'; plan: MergePlan; ancestorMatched: boolean }
  | { status: 'conflicts'; conflicts: MergeConflict[]; ancestorMatched: boolean }
  | { status: 'policy-failure'; reason: string }
  | {
      status: 'merged';
      mergeLayerId: string;
      refLayers: string[];
      plan: MergePlan;
      ancestorMatched: boolean;
    };

/** Core merge flow; returns an outcome instead of exiting (testable). */
export function mergeIntoRef(store: LayerStore, init: MergeInit): MergeOutcome {
  const candidateId = resolveLayerId(store, init.candidateId);
  const candidate = loadLayer(store, candidateId);
  const manifest = getProvenance(candidate);
  const entry = requireRef(store, init.into);
  const oursIds = [...entry.layers];
  const waivers = init.waivers ?? [];
  const resolver = init.principal ?? defaultPrincipal();

  // Fast path: candidate authored against the ref's current stack.
  if (manifest?.base?.kind === 'stack' && manifest.base.id === computeStackHash(oursIds)) {
    if (!init.preview) {
      const failure = checkRefPolicy(entry, manifest, waivers, init.approvedBy);
      if (failure) return { status: 'policy-failure', reason: failure };
      const refLayers = [...oursIds, candidateId];
      setRef(store, init.into, { ...entry, layers: refLayers });
      return { status: 'fast-forward', refLayers, ancestorMatched: true };
    }
    // Preview of a fast-forward is an empty plan.
    return {
      status: 'preview',
      plan: { autoOps: [], conflicts: [], stats: { touched: 0, autoMerged: 0, conflicting: 0 } },
      ancestorMatched: true,
    };
  }

  const ancestor = resolveAncestor(store, oursIds, manifest?.base ?? null);
  const ours = oursIds.map((id) => loadLayer(store, id));
  const plan = planThreeWayMerge({
    ancestor: ancestor.layers,
    ours,
    theirs: [...ancestor.layers, candidate],
  });

  if (init.preview) return { status: 'preview', plan, ancestorMatched: ancestor.matched };

  let resolutionInputs: ResolutionInput[] = [];
  if (plan.conflicts.length > 0) {
    if (!init.resolve) {
      return { status: 'conflicts', conflicts: plan.conflicts, ancestorMatched: ancestor.matched };
    }
    const choice = init.resolve;
    resolutionInputs = plan.conflicts.map((conflict) => {
      const input: ResolutionInput = { path: conflict.path, choice };
      if (conflict.componentKey !== undefined) input.componentKey = conflict.componentKey;
      return input;
    });
  }
  const applied = applyResolutions(plan, resolutionInputs);
  if (applied.unresolved.length > 0) {
    return { status: 'conflicts', conflicts: applied.unresolved, ancestorMatched: ancestor.matched };
  }

  const failure = checkRefPolicy(entry, manifest, waivers, init.approvedBy);
  if (failure) return { status: 'policy-failure', reason: failure };

  const waivedChecks: WaivedCheck[] = waivers.map((w) => ({
    spec: w.spec,
    reason: w.reason,
    waivedBy: resolver,
  }));
  const merged = buildMergeLayer({
    ops: [...plan.autoOps, ...applied.ops],
    author: { kind: 'human', principal: resolver },
    intent: `Merge ${candidateId} into ${init.into}`,
    base: { kind: 'stack', id: computeStackHash(oursIds) },
    merge: {
      candidate: candidateId,
      into: init.into,
      resolutions: applied.resolutions,
      waived_checks: waivedChecks,
      resolver,
    },
    created: init.created,
  });
  storeLayer(store, merged.file);
  const refLayers = [...oursIds, merged.layerId];
  setRef(store, init.into, { ...entry, layers: refLayers });
  return {
    status: 'merged',
    mergeLayerId: merged.layerId,
    refLayers,
    plan,
    ancestorMatched: ancestor.matched,
  };
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

function parseWaivers(args: string[]): Waiver[] {
  const specs = getAllFlags(args, '--waive');
  const reasons = getAllFlags(args, '--reason');
  if (specs.length !== reasons.length) {
    throw new Error('Each --waive <spec> requires a matching --reason "<text>"');
  }
  return specs.map((spec, i) => ({ spec, reason: reasons[i] }));
}

function printConflicts(conflicts: readonly MergeConflict[]): void {
  process.stderr.write(`${conflicts.length} conflict(s):\n`);
  for (const c of conflicts) {
    const component = c.componentKey ? ` ${c.componentKey}` : '';
    process.stderr.write(`  [${c.kind}] ${c.path}${component}\n`);
  }
}

export async function layerMergeCommand(args: string[]): Promise<void> {
  const candidateId = args[0];
  const into = getFlag(args, '--into');
  if (!candidateId || candidateId.startsWith('-') || !into) {
    throw new Error(
      'Usage: ifc-lite layer merge <layer-id> --into <ref> [--preview] [--resolve ours|theirs] [--waive <spec> --reason "<text>"]... [--approved-by <principal>] [--json]'
    );
  }
  const resolveFlag = getFlag(args, '--resolve');
  if (resolveFlag !== undefined && resolveFlag !== 'ours' && resolveFlag !== 'theirs') {
    throw new Error(`--resolve must be "ours" or "theirs", got "${resolveFlag}"`);
  }

  const store = storeFromArgs(args);
  const init: MergeInit = {
    candidateId,
    into,
    preview: hasFlag(args, '--preview'),
    waivers: parseWaivers(args),
  };
  if (resolveFlag !== undefined) init.resolve = resolveFlag;
  const approvedBy = getFlag(args, '--approved-by');
  if (approvedBy !== undefined) init.approvedBy = approvedBy;
  const principal = getFlag(args, '--principal');
  if (principal !== undefined) init.principal = principal;

  const outcome = mergeIntoRef(store, init);
  const json = hasFlag(args, '--json');

  if (outcome.status !== 'policy-failure' && outcome.status !== 'fast-forward' && !outcome.ancestorMatched) {
    process.stderr.write(
      'Warning: candidate base is unknown or not a prefix of the target ref — using an empty ancestor\n'
    );
  }

  switch (outcome.status) {
    case 'fast-forward':
      if (json) printJson({ status: outcome.status, ref: into, layers: outcome.refLayers });
      else process.stdout.write(`Fast-forwarded ${into} to ${shortId(candidateId)}\n`);
      return;
    case 'preview':
      if (json) printJson(outcome.plan);
      else {
        process.stdout.write(
          `plan: ${outcome.plan.autoOps.length} auto op(s), ${outcome.plan.conflicts.length} conflict(s)\n`
        );
        if (outcome.plan.conflicts.length > 0) printConflicts(outcome.plan.conflicts);
      }
      if (outcome.plan.conflicts.length > 0) process.exit(2);
      return;
    case 'conflicts':
      if (json) printJson({ status: outcome.status, conflicts: outcome.conflicts });
      else printConflicts(outcome.conflicts);
      process.exit(2);
      return;
    case 'policy-failure':
      if (json) printJson({ status: outcome.status, reason: outcome.reason });
      else process.stderr.write(`Policy failure: ${outcome.reason}\n`);
      process.exit(3);
      return;
    case 'merged':
      if (json) {
        printJson({
          status: outcome.status,
          mergeLayer: outcome.mergeLayerId,
          ref: into,
          layers: outcome.refLayers,
        });
      } else {
        process.stdout.write(`${outcome.mergeLayerId}\n`);
        process.stderr.write(`Merged ${shortId(candidateId)} into ${into}\n`);
      }
      return;
  }
}
