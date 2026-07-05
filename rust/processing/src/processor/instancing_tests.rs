// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit coverage for the `collate_into_instances` producer (#1623): conservation
//! (nothing gained or lost), exact recomposition of an occurrence against its
//! flag-off world geometry, and that `rep_identity` — not the shared product id —
//! is what disambiguates a multi-submesh (Tekla-style) product.

use super::collate_into_instances;
use crate::types::mesh::MeshData;
use ifc_lite_geometry::InstanceMeta;

/// Row-major translation mat4.
fn translate(tx: f64, ty: f64, tz: f64) -> [f64; 16] {
    [
        1.0, 0.0, 0.0, tx, //
        0.0, 1.0, 0.0, ty, //
        0.0, 0.0, 1.0, tz, //
        0.0, 0.0, 0.0, 1.0,
    ]
}

/// Canonical unit-triangle local geometry, shared by every occurrence of a rep.
fn unit_triangle() -> Vec<f32> {
    vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
}

/// Bake a canonical `xyz` triplet buffer into world space under a translation.
fn bake(local: &[f32], tx: f64, ty: f64, tz: f64) -> Vec<f32> {
    local
        .chunks_exact(3)
        .flat_map(|v| {
            [
                v[0] + tx as f32,
                v[1] + ty as f32,
                v[2] + tz as f32,
            ]
        })
        .collect()
}

/// A materialized occurrence: canonical geometry `local` baked under a pure
/// translation, carrying the matching `InstanceMeta` (transform == that same
/// translation, `local_transform` None) so `collate_refs` reconstructs it exactly.
fn occurrence(express_id: u32, rep_identity: u128, local: &[f32], t: (f64, f64, f64)) -> MeshData {
    let positions = bake(local, t.0, t.1, t.2);
    let normals = vec![0.0; positions.len()];
    let indices: Vec<u32> = (0..(positions.len() / 3) as u32).collect();
    MeshData::new(
        express_id,
        "IfcFlowFitting".to_string(),
        positions,
        normals,
        indices,
        [1.0, 1.0, 1.0, 1.0],
    )
    .with_instance(Some(InstanceMeta {
        transform: translate(t.0, t.1, t.2),
        local_transform: None,
        canonical_transform: None,
        rep_identity,
        instanceable: true,
    }))
}

/// Apply a row-major mat4 to a point, perspective-divided.
fn apply(t: &[f32; 16], x: f32, y: f32, z: f32) -> (f32, f32, f32) {
    let x = x as f64;
    let y = y as f64;
    let z = z as f64;
    let wx = t[0] as f64 * x + t[1] as f64 * y + t[2] as f64 * z + t[3] as f64;
    let wy = t[4] as f64 * x + t[5] as f64 * y + t[6] as f64 * z + t[7] as f64;
    let wz = t[8] as f64 * x + t[9] as f64 * y + t[10] as f64 * z + t[11] as f64;
    let ww = t[12] as f64 * x + t[13] as f64 * y + t[14] as f64 * z + t[15] as f64;
    ((wx / ww) as f32, (wy / ww) as f32, (wz / ww) as f32)
}

#[test]
fn collation_conserves_meshes_and_recomposes_the_occurrence() {
    let l = unit_triangle();
    // Two occurrences share rep 1 (collate); a singleton rep 2 stays flat.
    let template = occurrence(10, 1, &l, (0.0, 0.0, 0.0));
    let flag_off_occurrence = occurrence(11, 1, &l, (10.0, 0.0, 0.0));
    let singleton = occurrence(12, 2, &l, (0.0, 5.0, 0.0));

    // The world geometry the occurrence would have had with instancing OFF.
    let expected_world = flag_off_occurrence.positions.clone();

    let mut meshes = vec![template.clone(), flag_off_occurrence, singleton];
    let before = meshes.len();
    let out = collate_into_instances(&mut meshes, [0.0, 0.0, 0.0]);

    // Conservation: nothing gained or lost across the split.
    assert_eq!(
        before,
        meshes.len() + out.instances.len(),
        "meshes_before must equal meshes_after + instances"
    );
    assert_eq!(out.instances.len(), 1, "exactly one occurrence instanced");
    assert_eq!(out.total_meshes, meshes.len(), "counter tracks retained meshes");
    // Template (rep 1) + singleton (rep 2) retained; occurrence 11 folded out.
    assert_eq!(meshes.len(), 2);
    assert!(meshes.iter().any(|m| m.express_id == 10));
    assert!(meshes.iter().any(|m| m.express_id == 12));

    // Recomposition: the record's template-relative transform applied to the
    // template's baked world geometry reproduces the flag-off occurrence exactly.
    let rec = &out.instances[0];
    assert_eq!(rec.express_id, 11);
    assert_eq!(rec.rep_identity, 1);
    // The index binds straight to the retained template mesh (express 10, rep 1).
    let bound = &meshes[rec.template_mesh_index as usize];
    assert_eq!(bound.express_id, 10);
    assert_eq!(bound.instance.as_ref().unwrap().rep_identity, rec.rep_identity);
    for (i, v) in template.positions.chunks_exact(3).enumerate() {
        let (wx, wy, wz) = apply(&rec.transform, v[0], v[1], v[2]);
        assert!((wx - expected_world[i * 3]).abs() < 1e-4);
        assert!((wy - expected_world[i * 3 + 1]).abs() < 1e-4);
        assert!((wz - expected_world[i * 3 + 2]).abs() < 1e-4);
    }
}

#[test]
fn rep_identity_disambiguates_multi_submesh_product() {
    // A multi-item (Tekla-style) product emits several submeshes that SHARE its
    // express_id but carry DISTINCT rep_identity. Two such products (100, 200)
    // each contribute one submesh per rep; the collator must group by rep_identity,
    // never by the shared express_id.
    let l1 = unit_triangle();
    let l2 = vec![0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0, 0.0];

    let mut meshes = vec![
        occurrence(100, 10, &l1, (0.0, 0.0, 0.0)), // product 100, rep 10 (template)
        occurrence(100, 20, &l2, (0.0, 0.0, 0.0)), // product 100, rep 20 (template)
        occurrence(200, 10, &l1, (10.0, 0.0, 0.0)), // product 200, rep 10 -> instance
        occurrence(200, 20, &l2, (10.0, 0.0, 0.0)), // product 200, rep 20 -> instance
    ];
    let out = collate_into_instances(&mut meshes, [0.0, 0.0, 0.0]);

    assert_eq!(meshes.len(), 2, "one template retained per rep_identity");
    assert_eq!(out.instances.len(), 2, "one instanced occurrence per rep");

    // Both instances come from product 200 and carry the SAME template_express_id
    // (100, the ambiguous product id) yet bind to DIFFERENT templates — proving the
    // ambiguous product id must NOT be the join key. `template_mesh_index` resolves
    // each to the correct retained submesh, matched by rep_identity.
    for rec in &out.instances {
        assert_eq!(rec.express_id, 200);
        assert_eq!(rec.template_express_id, 100);
        let bound = &meshes[rec.template_mesh_index as usize];
        assert_eq!(
            bound.instance.as_ref().unwrap().rep_identity,
            rec.rep_identity,
            "template_mesh_index must point at the submesh of the matching rep_identity"
        );
    }
    let idxs: Vec<u32> = out.instances.iter().map(|r| r.template_mesh_index).collect();
    assert_ne!(
        idxs[0], idxs[1],
        "the two same-product instances must bind to distinct template meshes"
    );
    let mut reps: Vec<u128> = out.instances.iter().map(|r| r.rep_identity).collect();
    reps.sort_unstable();
    assert_eq!(reps, vec![10, 20], "rep_identity distinguishes the two submeshes");
}
