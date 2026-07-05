// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1623 Phase 2 "don't-bake" byte-identity gate.
//!
//! Runs the REAL geometry pipeline twice on an `IfcMappedItem`-heavy model:
//!   * flat (`enable_instancing = false`) — every occurrence materializes;
//!   * instanced (`enable_instancing = true`) — repeated single-solid sources mesh
//!     ONCE (a template occurrence) and every other occurrence becomes an
//!     `InstanceRecord`.
//!
//! It then proves the instanced output reproduces the flat output's WORLD TRIANGLES
//! bit-for-bit within a micrometre: for each occurrence,
//! `rel_k · (template.origin + template.positions)` equals the flat occurrence's baked
//! world vertices. This is the hard correctness gate — the ONLY intended change on the
//! instanced path is WHICH occurrence carries the geometry, never a world triangle.

use ifc_lite_processing::{
    process_geometry_streaming_filtered_with_options, InstanceRecord, MeshData, OpeningFilterMode,
    ProcessingResult, StreamingOptions,
};
use rustc_hash::FxHashMap;

/// A real repeated-`IfcMappedItem` sample (hello-wall: three RepresentationMaps).
fn sample_bytes() -> Vec<u8> {
    let path = format!(
        "{}/../../apps/viewer/public/samples/hello-wall.ifc",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// A synthetic model: ONE single-solid `IfcRepresentationMap` instanced by 64
/// `IfcBuildingElementProxy` occurrences at distinct placements — exercises the
/// don't-bake path at scale (63 skipped materializes, one template).
fn synthetic_bytes() -> Vec<u8> {
    let path = format!(
        "{}/../geometry/tests/fixtures/mapped_instances_synthetic.ifc",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

fn run(content: &[u8], enable_instancing: bool) -> ProcessingResult {
    process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        StreamingOptions {
            enable_instancing,
            ..StreamingOptions::default()
        },
        |_, _, _| {},
        |_| {},
        |_| {},
    )
}

/// World vertices of a mesh = `origin + position` per vertex (the renderer's
/// reconstruction), as an `f64` triple list.
fn world_vertices(m: &MeshData) -> Vec<[f64; 3]> {
    let n = m.positions.len() / 3;
    (0..n)
        .map(|v| {
            [
                m.origin[0] + m.positions[v * 3] as f64,
                m.origin[1] + m.positions[v * 3 + 1] as f64,
                m.origin[2] + m.positions[v * 3 + 2] as f64,
            ]
        })
        .collect()
}

/// Apply a row-major mat4 to a homogeneous point (perspective divided).
fn apply(t: &[f32; 16], p: [f64; 3]) -> [f64; 3] {
    let (x, y, z) = (p[0], p[1], p[2]);
    let wx = t[0] as f64 * x + t[1] as f64 * y + t[2] as f64 * z + t[3] as f64;
    let wy = t[4] as f64 * x + t[5] as f64 * y + t[6] as f64 * z + t[7] as f64;
    let wz = t[8] as f64 * x + t[9] as f64 * y + t[10] as f64 * z + t[11] as f64;
    let ww = t[12] as f64 * x + t[13] as f64 * y + t[14] as f64 * z + t[15] as f64;
    [wx / ww, wy / ww, wz / ww]
}

fn max_vertex_error(a: &[[f64; 3]], b: &[[f64; 3]]) -> f64 {
    assert_eq!(a.len(), b.len(), "vertex count mismatch ({} vs {})", a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(p, q)| {
            ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
        })
        .fold(0.0f64, f64::max)
}

fn assert_instanced_matches_flat(bytes: &[u8], label: &str) {
    let flat = run(bytes, false);
    let inst = run(bytes, true);

    // The don't-bake path must actually fire, or this proves nothing.
    assert!(
        !inst.instances.is_empty(),
        "{label}: instancing produced no InstanceRecords — the don't-bake path did not fire \
         (sample has no repeated single-solid mapped source?)"
    );

    // Flat occurrence lookup: express_id -> its single class-0 mesh. The eligible
    // don't-bake set is single-solid, so each such occurrence is one mesh flat.
    let mut flat_by_id: FxHashMap<u32, &MeshData> = FxHashMap::default();
    for m in &flat.meshes {
        if m.geometry_class == 0 && !m.positions.is_empty() {
            flat_by_id.entry(m.express_id).or_insert(m);
        }
    }
    // Instanced template lookup: express_id -> template mesh (stays in meshes).
    let mut inst_mesh_by_id: FxHashMap<u32, &MeshData> = FxHashMap::default();
    for m in &inst.meshes {
        if !m.positions.is_empty() {
            inst_mesh_by_id.entry(m.express_id).or_insert(m);
        }
    }

    let tol = 1e-6; // 1 micrometre, in model metres.
    let mut checked_instances = 0usize;

    // (1) Every InstanceRecord recomposes to its flat occurrence's world triangles.
    for rec in &inst.instances {
        let template = inst_mesh_by_id.get(&rec.template_express_id).unwrap_or_else(|| {
            panic!(
                "instance {} references template {} not present in instanced meshes",
                rec.express_id, rec.template_express_id
            )
        });
        let flat_occ = flat_by_id.get(&rec.express_id).unwrap_or_else(|| {
            panic!("instance {} has no flat counterpart mesh", rec.express_id)
        });

        let template_world = world_vertices(template);
        let recomposed: Vec<[f64; 3]> =
            template_world.iter().map(|&p| apply(&rec.transform, p)).collect();
        let flat_world = world_vertices(flat_occ);

        let err = max_vertex_error(&recomposed, &flat_world);
        assert!(
            err < tol,
            "{label}: instance {} (template {}): world-vertex error {err:.3e} m exceeds 1um",
            rec.express_id, rec.template_express_id
        );
        checked_instances += 1;
    }
    assert_eq!(checked_instances, inst.instances.len());

    // (2) Each template occurrence itself is byte-identical flat vs instanced (it
    //     goes through the exact same materialize; only its rep_identity was re-tagged).
    for rec in &inst.instances {
        let tid = rec.template_express_id;
        let inst_t = inst_mesh_by_id[&tid];
        let flat_t = flat_by_id
            .get(&tid)
            .unwrap_or_else(|| panic!("template {tid} missing from flat meshes"));
        let err = max_vertex_error(&world_vertices(inst_t), &world_vertices(flat_t));
        assert!(
            err < tol,
            "{label}: template {tid}: instanced vs flat world-vertex error {err:.3e} m exceeds 1um"
        );
    }

    // (3) No geometry lost: every flat occurrence is represented in the instanced
    //     output either as a retained mesh (template / non-instanced) or an instance.
    let inst_ids: std::collections::HashSet<u32> = inst
        .meshes
        .iter()
        .map(|m| m.express_id)
        .chain(inst.instances.iter().map(|r| r.express_id))
        .collect();
    for m in &flat.meshes {
        if m.geometry_class == 0 && !m.positions.is_empty() {
            assert!(
                inst_ids.contains(&m.express_id),
                "{label}: flat occurrence {} is absent from the instanced output (geometry lost)",
                m.express_id
            );
        }
    }
}

/// The materialize reduction: the instanced run emits FEWER full meshes than the flat
/// run (repeated occurrences become records), while representing the same occurrences.
fn assert_reduction(bytes: &[u8], label: &str) {
    let flat = run(bytes, false);
    let inst = run(bytes, true);

    let flat_meshes = flat.meshes.iter().filter(|m| !m.positions.is_empty()).count();
    let inst_meshes = inst.meshes.iter().filter(|m| !m.positions.is_empty()).count();
    let flat_verts: usize = flat.meshes.iter().map(|m| m.positions.len() / 3).sum();
    let inst_verts: usize = inst.meshes.iter().map(|m| m.positions.len() / 3).sum();

    assert!(!inst.instances.is_empty(), "{label}: don't-bake did not fire");
    assert!(
        inst_meshes < flat_meshes,
        "{label}: instanced materialized meshes ({inst_meshes}) not fewer than flat ({flat_meshes})"
    );
    // Every non-template occurrence is one skipped materialize.
    assert_eq!(
        inst_meshes + inst.instances.len(),
        flat_meshes,
        "{label}: templates + instances must equal the flat occurrence count"
    );

    eprintln!(
        "[#1623 P2] {label}: flat = {flat_meshes} meshes / {flat_verts} verts; \
         instanced = {inst_meshes} templates + {} instance records / {inst_verts} materialized verts \
         (materialize reduction: {} meshes, {} verts)",
        inst.instances.len(),
        flat_meshes - inst_meshes,
        flat_verts.saturating_sub(inst_verts),
    );
    // Reference the type so the import stays load-bearing regardless of assertions.
    let _: fn(&InstanceRecord) -> u32 = |r| r.express_id;
}

#[test]
fn instanced_world_triangles_equal_flat_hello_wall() {
    assert_instanced_matches_flat(&sample_bytes(), "hello-wall");
}

#[test]
fn instanced_world_triangles_equal_flat_synthetic() {
    assert_instanced_matches_flat(&synthetic_bytes(), "synthetic-64");
}

#[test]
fn instancing_reduces_materialized_meshes_hello_wall() {
    assert_reduction(&sample_bytes(), "hello-wall");
}

#[test]
fn instancing_reduces_materialized_meshes_synthetic() {
    assert_reduction(&synthetic_bytes(), "synthetic-64");
}
