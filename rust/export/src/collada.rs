// SPDX-License-Identifier: MPL-2.0
//! **COLLADA 1.4.1** (`.dae`) exporter — the model format Google Earth's KML
//! `<Model>` actually loads (it does NOT accept glTF/GLB; a `.glb` in `<Model>`
//! fails with "Unsupported element: Model"). Used to build the KMZ payload (#1427).
//!
//! Input is the viewer's already-produced **Y-up** `MeshData` (the from-meshes
//! path), identical to the GLB exporter. Two Google-Earth-specific choices make
//! the model render correctly:
//!
//! - **Orientation:** vertices are converted back to the IFC-native **Z-up** frame
//!   (`(x, y, z)_yup -> (x, -z, y)_zup`) and the document declares `<up_axis>Z_UP</up_axis>`,
//!   so the building stands upright. Horizontal grid-north alignment is carried by
//!   the KML `<Model><Orientation><heading>` (computed elsewhere), exactly as the
//!   GLB path did, so X/Y placement matches the (already-correct) GLB output.
//! - **Brightness:** Google Earth has no ambient/IBL and a single hard sun, so a
//!   plain diffuse material renders near-black. Each material sets `<emission>` to
//!   its colour (the well-known "make Google Earth models glow" trick) so the model
//!   shows its true colour. Faces are flagged `double_sided` via the `GOOGLEEARTH`
//!   profile extra (IFC winding isn't reliably outward).

use std::collections::HashMap;
use std::fmt::Write as _;

/// Material dedup key: RGBA rounded to 2 decimals (matches the glTF exporter).
fn color_key(c: [f32; 4]) -> (i32, i32, i32, i32) {
    let r = |v: f32| (v * 100.0).round() as i32;
    (r(c[0]), r(c[1]), r(c[2]), r(c[3]))
}

/// Convert a Y-up vector back to the IFC-native Z-up frame: `(x, y, z) -> (x, -z, y)`.
#[inline]
fn to_zup(x: f32, y: f32, z: f32) -> [f32; 3] {
    [x, -z, y]
}

/// Build a Google-Earth-compatible COLLADA 1.4.1 `.dae` from already-produced
/// (Y-up) meshes, flattened into parallel arrays exactly like
/// `export_glb_from_meshes`. Per mesh `i`: `vertex_counts[i]` vertices +
/// `index_counts[i]` indices taken in order from the concatenated
/// `positions`/`normals`/`indices`; `colors` is RGBA per mesh, `origins` xyz per
/// mesh (`world = origin + position`). Returns the `.dae` bytes (UTF-8 XML).
#[allow(clippy::too_many_arguments)]
#[allow(clippy::needless_range_loop)]
pub fn export_collada_from_meshes(
    positions: &[f32],
    normals: &[f32],
    indices: &[u32],
    vertex_counts: &[u32],
    index_counts: &[u32],
    colors: &[f32],
    origins: &[f64],
) -> Vec<u8> {
    // Concatenated Z-up vertex buffers (one shared POSITION + NORMAL source) and,
    // per material, the triangle indices into that shared buffer.
    let mut pos: Vec<f32> = Vec::new();
    let mut nrm: Vec<f32> = Vec::new();
    let mut mat_colors: Vec<[f32; 4]> = Vec::new();
    let mut mat_tris: Vec<Vec<u32>> = Vec::new();
    let mut mat_map: HashMap<(i32, i32, i32, i32), usize> = HashMap::new();

    let n = vertex_counts.len();
    let mut vbase = 0usize; // running vertex offset into the flat input
    let mut ibase = 0usize; // running index offset into the flat input
    let mut vout = 0u32; // running vertex offset into the output (shared) buffer
    for i in 0..n {
        let vc = vertex_counts[i] as usize;
        let ic = index_counts.get(i).copied().unwrap_or(0) as usize;
        if (vbase + vc) * 3 > positions.len() || ibase + ic > indices.len() {
            break; // malformed counts — stop rather than panic
        }
        let pslice = &positions[vbase * 3..(vbase + vc) * 3];
        let nslice: &[f32] = if normals.len() >= (vbase + vc) * 3 {
            &normals[vbase * 3..(vbase + vc) * 3]
        } else {
            &[]
        };
        let islice = &indices[ibase..ibase + ic];
        let color = [
            colors.get(i * 4).copied().unwrap_or(0.8),
            colors.get(i * 4 + 1).copied().unwrap_or(0.8),
            colors.get(i * 4 + 2).copied().unwrap_or(0.8),
            colors.get(i * 4 + 3).copied().unwrap_or(1.0),
        ];
        let origin = [
            origins.get(i * 3).copied().unwrap_or(0.0),
            origins.get(i * 3 + 1).copied().unwrap_or(0.0),
            origins.get(i * 3 + 2).copied().unwrap_or(0.0),
        ];

        // Skip degenerate meshes (mirrors the glTF `view_ok` guard).
        if islice.is_empty() || pslice.len() < 9 || !pslice.len().is_multiple_of(3) {
            vbase += vc;
            ibase += ic;
            continue;
        }

        // Bake world = origin + position, converted to Z-up. RTC-relative render
        // coords are small, so f32 keeps full precision without re-centring.
        for v in pslice.chunks_exact(3) {
            let wx = v[0] as f64 + origin[0];
            let wy = v[1] as f64 + origin[1];
            let wz = v[2] as f64 + origin[2];
            let z = to_zup(wx as f32, wy as f32, wz as f32);
            pos.extend_from_slice(&z);
        }
        if nslice.len() == pslice.len() {
            for nv in nslice.chunks_exact(3) {
                let z = to_zup(nv[0], nv[1], nv[2]);
                nrm.extend_from_slice(&z);
            }
        } else {
            // No usable normals — emit a placeholder up-normal per vertex so the
            // accessor stays valid (Google Earth tolerates this).
            for _ in 0..vc {
                nrm.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
        }

        let key = color_key(color);
        let mi = *mat_map.entry(key).or_insert_with(|| {
            mat_colors.push(color);
            mat_tris.push(Vec::new());
            mat_colors.len() - 1
        });
        // Re-base local indices into the shared output buffer. Keep only whole
        // triangles: a trailing partial triangle (index count not a multiple of 3)
        // would desync `<triangles count>` from the `<p>` list and emit malformed
        // COLLADA. Also drop indices that fall outside this mesh's vertex range.
        let tri_len = islice.len() - islice.len() % 3;
        for tri in islice[..tri_len].chunks_exact(3) {
            if tri.iter().all(|&idx| (idx as usize) < vc) {
                for &idx in tri {
                    mat_tris[mi].push(vout + idx);
                }
            }
        }

        vout += vc as u32;
        vbase += vc;
        ibase += ic;
    }

    // Center the model on its horizontal (X,Y) AABB centre so the .dae origin
    // coincides with the geometry centre. The KMZ <Model> pins the .dae origin to
    // <Location>, and that lat/lon is computed for the geometry's AABB centre (the
    // viewer's reproject adds the model centre to the MapConversion eastings/northings).
    // Without this the model lands offset by however far its geometry sits from the
    // local/survey origin — e.g. a CH1903+/LV95 model whose structure is 200 m from
    // the project origin appeared ~250 m away in Google Earth (#1427). Z is left alone
    // so clampToGround rests project-zero on the terrain (foundations below, frame above).
    if pos.len() >= 3 {
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        for v in pos.chunks_exact(3) {
            min_x = min_x.min(v[0]);
            max_x = max_x.max(v[0]);
            min_y = min_y.min(v[1]);
            max_y = max_y.max(v[1]);
        }
        let cx = (min_x + max_x) * 0.5;
        let cy = (min_y + max_y) * 0.5;
        for v in pos.chunks_exact_mut(3) {
            v[0] -= cx;
            v[1] -= cy;
        }
    }

    write_dae(&pos, &nrm, &mat_colors, &mat_tris)
}

/// Serialise the collected geometry + materials into a COLLADA 1.4.1 document.
fn write_dae(
    pos: &[f32],
    nrm: &[f32],
    mat_colors: &[[f32; 4]],
    mat_tris: &[Vec<u32>],
) -> Vec<u8> {
    let vert_count = pos.len() / 3;
    let mut s = String::with_capacity(pos.len() * 8 + 2048);

    // `<created>`/`<modified>` are REQUIRED by the COLLADA 1.4.1 schema; a fixed
    // epoch keeps the document deterministic and wasm-safe (no wall clock).
    s.push_str(r#"<?xml version="1.0" encoding="UTF-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <contributor><authoring_tool>IFC-Lite</authoring_tool></contributor>
    <created>1970-01-01T00:00:00Z</created>
    <modified>1970-01-01T00:00:00Z</modified>
    <unit name="meter" meter="1"/>
    <up_axis>Z_UP</up_axis>
  </asset>
"#);

    // ── Effects: emission = colour (Google Earth glow) + double_sided ───────────
    s.push_str("  <library_effects>\n");
    for (k, c) in mat_colors.iter().enumerate() {
        // emission = colour is the brightness lever (no ambient/IBL in Google Earth);
        // ambient is zeroed so the engine's ambient term can't darken the surface.
        let _ = write!(
            s,
            r#"    <effect id="eff{k}">
      <profile_COMMON>
        <technique sid="common">
          <lambert>
            <emission><color>{r} {g} {b} 1</color></emission>
            <ambient><color>0 0 0 1</color></ambient>
            <diffuse><color>{r} {g} {b} 1</color></diffuse>
"#,
            k = k,
            r = c[0],
            g = c[1],
            b = c[2],
        );
        if c[3] < 1.0 {
            // A_ONE: final opacity is the transparent colour's alpha (transparency
            // kept at 1). Carry the material colour + its alpha so Google Earth
            // renders the surface translucent at the authored colour.
            let _ = write!(
                s,
                "            <transparent opaque=\"A_ONE\"><color>{r} {g} {b} {a}</color></transparent>\n            <transparency><float>1</float></transparency>\n",
                r = c[0],
                g = c[1],
                b = c[2],
                a = c[3],
            );
        }
        // GOOGLEEARTH double_sided is an <extra> on <profile_COMMON> (a sibling of
        // <technique sid="common">, NOT inside it) — the schema-validated placement
        // Google Earth reads. IFC winding isn't reliably outward, so render both sides.
        s.push_str(
            r#"          </lambert>
        </technique>
        <extra><technique profile="GOOGLEEARTH"><double_sided>1</double_sided></technique></extra>
      </profile_COMMON>
    </effect>
"#,
        );
    }
    s.push_str("  </library_effects>\n");

    // ── Materials ───────────────────────────────────────────────────────────────
    s.push_str("  <library_materials>\n");
    for k in 0..mat_colors.len() {
        let _ = writeln!(
            s,
            "    <material id=\"mat{k}\" name=\"mat{k}\"><instance_effect url=\"#eff{k}\"/></material>",
            k = k
        );
    }
    s.push_str("  </library_materials>\n");

    // ── Geometry: one shared mesh, one <triangles> per material ─────────────────
    s.push_str("  <library_geometries>\n    <geometry id=\"geo\" name=\"geo\">\n      <mesh>\n");

    // POSITION source.
    let _ = write!(
        s,
        "        <source id=\"geo-pos\">\n          <float_array id=\"geo-pos-arr\" count=\"{}\">",
        pos.len()
    );
    append_floats(&mut s, pos);
    let _ = write!(
        s,
        "</float_array>\n          <technique_common>\n            <accessor source=\"#geo-pos-arr\" count=\"{vc}\" stride=\"3\">\n              <param name=\"X\" type=\"float\"/><param name=\"Y\" type=\"float\"/><param name=\"Z\" type=\"float\"/>\n            </accessor>\n          </technique_common>\n        </source>\n",
        vc = vert_count
    );

    // NORMAL source.
    let _ = write!(
        s,
        "        <source id=\"geo-nrm\">\n          <float_array id=\"geo-nrm-arr\" count=\"{}\">",
        nrm.len()
    );
    append_floats(&mut s, nrm);
    let _ = write!(
        s,
        "</float_array>\n          <technique_common>\n            <accessor source=\"#geo-nrm-arr\" count=\"{vc}\" stride=\"3\">\n              <param name=\"X\" type=\"float\"/><param name=\"Y\" type=\"float\"/><param name=\"Z\" type=\"float\"/>\n            </accessor>\n          </technique_common>\n        </source>\n",
        vc = nrm.len() / 3
    );

    // Shared vertices referencing POSITION.
    s.push_str("        <vertices id=\"geo-vtx\">\n          <input semantic=\"POSITION\" source=\"#geo-pos\"/>\n        </vertices>\n");

    // One <triangles> per material; <p> interleaves VERTEX + NORMAL indices (equal).
    for (k, tris) in mat_tris.iter().enumerate() {
        if tris.is_empty() {
            continue;
        }
        let _ = write!(
            s,
            "        <triangles material=\"sym{k}\" count=\"{c}\">\n          <input semantic=\"VERTEX\" source=\"#geo-vtx\" offset=\"0\"/>\n          <input semantic=\"NORMAL\" source=\"#geo-nrm\" offset=\"1\"/>\n          <p>",
            k = k,
            c = tris.len() / 3
        );
        for (j, &idx) in tris.iter().enumerate() {
            if j > 0 {
                s.push(' ');
            }
            // VERTEX and NORMAL share the index.
            let _ = write!(s, "{idx} {idx}");
        }
        s.push_str("</p>\n        </triangles>\n");
    }

    s.push_str("      </mesh>\n    </geometry>\n  </library_geometries>\n");

    // ── Visual scene: instance the geometry, bind each material symbol ──────────
    s.push_str("  <library_visual_scenes>\n    <visual_scene id=\"scene\">\n      <node id=\"model\" name=\"model\">\n        <instance_geometry url=\"#geo\">\n          <bind_material>\n            <technique_common>\n");
    for (k, tris) in mat_tris.iter().enumerate() {
        if tris.is_empty() {
            continue;
        }
        let _ = writeln!(
            s,
            "              <instance_material symbol=\"sym{k}\" target=\"#mat{k}\"/>",
            k = k
        );
    }
    s.push_str("            </technique_common>\n          </bind_material>\n        </instance_geometry>\n      </node>\n    </visual_scene>\n  </library_visual_scenes>\n");

    s.push_str("  <scene><instance_visual_scene url=\"#scene\"/></scene>\n</COLLADA>\n");

    s.into_bytes()
}

/// Append space-separated floats, trimming trailing zeros for compactness while
/// keeping enough precision for metre-scale building coordinates.
fn append_floats(s: &mut String, vals: &[f32]) {
    for (i, v) in vals.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        let _ = write!(s, "{}", fmt_f32(*v));
    }
}

/// Format an f32 with up to 6 significant decimals, no trailing zeros.
fn fmt_f32(v: f32) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    let mut t = format!("{v:.6}");
    if t.contains('.') {
        while t.ends_with('0') {
            t.pop();
        }
        if t.ends_with('.') {
            t.pop();
        }
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `(positions, normals, indices, vertex_counts, index_counts, colors, origins)`.
    type MeshArrays = (Vec<f32>, Vec<f32>, Vec<u32>, Vec<u32>, Vec<u32>, Vec<f32>, Vec<f64>);

    fn one_quad() -> MeshArrays {
        // A unit quad in the XY plane (Y-up input), single red mesh.
        let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 4).flatten().collect();
        let indices = vec![0u32, 1, 2, 0, 2, 3];
        (positions, normals, indices, vec![4], vec![6], vec![1.0, 0.0, 0.0, 1.0], vec![0.0, 0.0, 0.0])
    }

    #[test]
    fn emits_valid_collada_skeleton() {
        let (p, n, i, vc, ic, col, og) = one_quad();
        let dae = export_collada_from_meshes(&p, &n, &i, &vc, &ic, &col, &og);
        let xml = String::from_utf8(dae).unwrap();
        assert!(xml.contains(r#"version="1.4.1""#));
        assert!(xml.contains("<up_axis>Z_UP</up_axis>"));
        assert!(xml.contains("<unit name=\"meter\" meter=\"1\"/>"));
        assert!(xml.contains("<instance_visual_scene url=\"#scene\"/>"));
        // The shared geometry + a triangles block bound to the material.
        assert!(xml.contains("<triangles material=\"sym0\""));
        assert!(xml.contains("<instance_material symbol=\"sym0\" target=\"#mat0\"/>"));
    }

    #[test]
    fn emission_carries_colour_and_double_sided() {
        let (p, n, i, vc, ic, col, og) = one_quad();
        let xml = String::from_utf8(export_collada_from_meshes(&p, &n, &i, &vc, &ic, &col, &og)).unwrap();
        // Red emission = brightness lever for Google Earth.
        assert!(xml.contains("<emission><color>1 0 0 1</color></emission>"));
        assert!(xml.contains("<double_sided>1</double_sided>"));
        assert!(xml.contains("profile=\"GOOGLEEARTH\""));
    }

    /// Parse the `<float_array id="geo-pos-arr">` back into vertices.
    fn parse_positions(xml: &str) -> Vec<[f32; 3]> {
        let start = xml.find("geo-pos-arr").unwrap();
        let s = &xml[start..];
        let open = s.find('>').unwrap() + 1;
        let close = s.find("</float_array>").unwrap();
        s[open..close]
            .split_whitespace()
            .map(|t| t.parse::<f32>().unwrap())
            .collect::<Vec<_>>()
            .chunks_exact(3)
            .map(|c| [c[0], c[1], c[2]])
            .collect()
    }

    fn hbounds(verts: &[[f32; 3]]) -> (f32, f32) {
        let (mut mnx, mut mxx, mut mny, mut mxy) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
        for v in verts {
            mnx = mnx.min(v[0]);
            mxx = mxx.max(v[0]);
            mny = mny.min(v[1]);
            mxy = mxy.max(v[1]);
        }
        ((mnx + mxx) / 2.0, (mny + mxy) / 2.0) // (X centre, Y centre)
    }

    #[test]
    fn converts_yup_to_zup_and_centers() {
        // Y-up input vertex (0,1,0) ("up") must land at Z-up Z=1 (up preserved), and the
        // geometry is centred on its horizontal AABB so the .dae origin == geometry centre.
        let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 0.0, 1.0], 3).flatten().collect();
        let xml = String::from_utf8(export_collada_from_meshes(
            &positions, &normals, &[0, 1, 2], &[3], &[3], &[0.5, 0.5, 0.5, 1.0], &[0.0, 0.0, 0.0],
        ))
        .unwrap();
        let verts = parse_positions(&xml);
        assert!(verts.iter().any(|v| (v[2] - 1.0).abs() < 1e-4), "Y-up (0,1,0) -> Z-up Z=1");
        let (cx, cy) = hbounds(&verts);
        assert!(cx.abs() < 1e-4 && cy.abs() < 1e-4, "geometry centred: ({cx}, {cy})");
    }

    #[test]
    fn centers_geometry_far_from_origin() {
        // A model whose geometry sits ~100-200 m from the local/survey origin must be
        // re-centred so the .dae origin == geometry centre — the point the KMZ <Location>
        // is computed for. This is the CH1903+/LV95 ~250 m offset fix (#1427).
        let positions = vec![
            100.0, 0.0, 200.0, 110.0, 0.0, 200.0, 110.0, 0.0, 220.0, 100.0, 0.0, 220.0,
        ];
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 4).flatten().collect();
        let xml = String::from_utf8(export_collada_from_meshes(
            &positions, &normals, &[0, 1, 2, 0, 2, 3], &[4], &[6], &[0.6, 0.6, 0.6, 1.0], &[0.0, 0.0, 0.0],
        ))
        .unwrap();
        let (cx, cy) = hbounds(&parse_positions(&xml));
        assert!(cx.abs() < 1e-3, "X re-centred to ~0 (geometry was ~105 from origin): {cx}");
        assert!(cy.abs() < 1e-3, "Y re-centred to ~0 (geometry was ~210 from origin): {cy}");
    }

    #[test]
    fn triangles_count_matches_index_list_on_ragged_input() {
        // A malformed index count (not a multiple of 3) must not desync the emitted
        // <triangles count> from the <p> list — keep only whole triangles.
        let positions = vec![0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.5, 0.0, 0.5];
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 4).flatten().collect();
        let indices = vec![0u32, 1, 2, 0, 2]; // 5 indices = one whole triangle + a stray pair
        let xml = String::from_utf8(export_collada_from_meshes(
            &positions, &normals, &indices, &[4], &[5], &[0.3, 0.3, 0.3, 1.0], &[0.0, 0.0, 0.0],
        ))
        .unwrap();
        // Exactly one triangle survives; its <p> holds 3 vertex+normal index pairs (6 ints).
        assert!(xml.contains("<triangles material=\"sym0\" count=\"1\">"));
        let p_start = xml.find("<p>").unwrap() + 3;
        let p = &xml[p_start..xml[p_start..].find("</p>").unwrap() + p_start];
        assert_eq!(p.split_whitespace().count(), 6, "one triangle = 3 pairs = 6 indices: {p}");
    }

    #[test]
    fn translucent_material_emits_transparency() {
        let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0];
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 3).flatten().collect();
        let xml = String::from_utf8(export_collada_from_meshes(
            &positions, &normals, &[0, 1, 2], &[3], &[3], &[0.0, 1.0, 0.0, 0.5], &[0.0, 0.0, 0.0],
        ))
        .unwrap();
        assert!(xml.contains("<transparency>"));
        assert!(xml.contains("opaque=\"A_ONE\""));
    }
}
