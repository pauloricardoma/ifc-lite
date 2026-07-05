// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Instanced streaming output (#1623).
//!
//! Post-pass collation of the retained, already-materialized meshes: occurrences
//! sharing a representation identity collapse onto one template `MeshData` plus a
//! lightweight [`InstanceRecord`] each. This is an OUTPUT/memory dedup — the
//! occurrences are still meshed and streamed first; collation runs afterwards.
//! The separate CPU (don't-bake) win layers on top later. Split out of
//! `processor/mod.rs` so the orchestrator stays under its module-size budget.

use crate::types::mesh::MeshData;

/// One occurrence of a shared template geometry, emitted INSTEAD of a full
/// materialized mesh when `StreamingOptions.enable_instancing` is set (#1623).
///
/// On instance-heavy models (metering stations, MEP, steel) many products share
/// one representation; rather than keep a materialized world mesh per occurrence,
/// the engine retains the shared geometry ONCE (a template `MeshData`) and emits
/// one of these per additional occurrence. The consumer draws the template placed
/// by `transform` and identifies/colours the occurrence from the remaining
/// fields. Purely in-memory (recomputed each load, never round-trips a cache),
/// like [`ifc_lite_geometry::InstanceMeta`].
#[derive(Debug, Clone)]
pub struct InstanceRecord {
    /// This occurrence's IFC element id.
    pub express_id: u32,
    /// IFC type name (e.g. "IfcFlowFitting").
    pub ifc_type: String,
    /// IFC GlobalId when available.
    pub global_id: Option<String>,
    /// IFC Name when available.
    pub name: Option<String>,
    /// IFC presentation layer assignment name when available.
    pub presentation_layer: Option<String>,
    /// This occurrence's RGBA colour (may differ from the template occurrence's).
    pub color: [f32; 4],
    /// Index of the template `MeshData` in the returned `ProcessingResult.meshes`
    /// — the stable, O(1) binding from this record to its geometry. Prefer this
    /// over [`template_express_id`](Self::template_express_id), which is not unique.
    pub template_mesh_index: u32,
    /// `express_id` of the template occurrence's `MeshData`. INFORMATIONAL only —
    /// it is the product id and is NOT unique (a multi-item Tekla product yields
    /// several retained submeshes sharing it), so it must not be used to bind an
    /// instance to a template; use [`template_mesh_index`](Self::template_mesh_index).
    pub template_express_id: u32,
    /// Representation-identity (content identity) of the shared geometry: a full
    /// 128-bit content hash on the direct-solid path, or the `IfcRepresentationMap`
    /// id for mapped items. The same key that grouped these occurrences (and that
    /// the GLB export instancing keys on); carried for dedup/parity reasoning.
    pub rep_identity: u128,
    /// Row-major, TEMPLATE-RELATIVE mat4: applied to the template's baked world
    /// geometry (`template.origin + positions`) it yields this occurrence's world
    /// geometry (`collate_refs`' `rel_k = m_k · m_ref⁻¹`; identity for the template
    /// occurrence itself, which is why the template is never emitted as a record).
    pub transform: [f32; 16],
}

/// Result of [`collate_into_instances`]: the per-occurrence records plus the mesh
/// counters RECOMPUTED from the retained `meshes` after the instanced occurrences
/// were dropped, so `ProcessingStats` reports the returned data rather than the
/// pre-collation materialized figures.
pub(crate) struct InstancingResult {
    pub instances: Vec<InstanceRecord>,
    pub total_meshes: usize,
    pub total_vertices: usize,
    pub total_triangles: usize,
}

/// Collate materialized meshes by representation identity (#1623): every occurrence
/// beyond the first of each shared template becomes an [`InstanceRecord`] and its
/// `MeshData` is removed from `meshes`, leaving one template per group (plus all
/// non-instanced meshes). The per-occurrence transform is template-relative, the
/// same collation the GLB export instancing (#1443) uses. `rtc` is the model RTC
/// offset (see `collate_refs`). The returned counters reflect the retained meshes.
pub(crate) fn collate_into_instances(meshes: &mut Vec<MeshData>, rtc: [f64; 3]) -> InstancingResult {
    use ifc_lite_geometry::{collate_refs, InstanceMeshRef};

    let refs: Vec<InstanceMeshRef> = meshes
        .iter()
        .map(|m| InstanceMeshRef {
            positions: &m.positions,
            normals: &m.normals,
            indices: &m.indices,
            origin: m.origin,
            instance_meta: m.instance.as_ref(),
            entity_id: m.express_id,
            color: m.color,
        })
        .collect();
    let collated = collate_refs(&refs, 2, rtc);

    // Pass 1: mark which meshes are folded out (every non-template occurrence).
    // Templates are never dropped, so their post-retain index is well-defined.
    let mut drop_mesh = vec![false; meshes.len()];
    for tpl in &collated.templates {
        for occ in &tpl.occurrences {
            if occ.mesh_index != tpl.template_index {
                drop_mesh[occ.mesh_index] = true;
            }
        }
    }
    // Map each surviving mesh's pre-collation index to its index in the retained
    // vec (running count of kept meshes before it), so records can point straight
    // at their template in `ProcessingResult.meshes`.
    let mut retained_index = vec![0u32; meshes.len()];
    let mut kept = 0u32;
    for (i, dropped) in drop_mesh.iter().enumerate() {
        retained_index[i] = kept;
        if !dropped {
            kept += 1;
        }
    }

    let mut instances = Vec::new();
    for tpl in &collated.templates {
        let template_express_id = meshes[tpl.template_index].express_id;
        let template_mesh_index = retained_index[tpl.template_index];
        for occ in &tpl.occurrences {
            // The template occurrence is drawn directly from its retained MeshData.
            if occ.mesh_index == tpl.template_index {
                continue;
            }
            let m = &meshes[occ.mesh_index];
            instances.push(InstanceRecord {
                express_id: m.express_id,
                ifc_type: m.ifc_type.clone(),
                global_id: m.global_id.clone(),
                name: m.name.clone(),
                presentation_layer: m.presentation_layer.clone(),
                color: m.color,
                template_mesh_index,
                template_express_id,
                rep_identity: tpl.rep_identity,
                transform: occ.transform,
            });
        }
    }

    // Drop the instanced (non-template) occurrence meshes; `retain` visits in order.
    let mut idx = 0;
    meshes.retain(|_| {
        let keep = !drop_mesh[idx];
        idx += 1;
        keep
    });

    // Recompute the mesh counters from what actually remains: the pre-collation
    // `total_*` counted every materialized occurrence, but those are now folded
    // into `instances`, so reporting them would overstate the returned geometry.
    InstancingResult {
        instances,
        total_meshes: meshes.len(),
        total_vertices: meshes.iter().map(|m| m.vertex_count()).sum(),
        total_triangles: meshes.iter().map(|m| m.triangle_count()).sum(),
    }
}

#[cfg(test)]
#[path = "instancing_tests.rs"]
mod instancing_tests;
