// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Entity-job metadata backfill for the wasm32 serial path.
//!
//! Split out of `processor/mod.rs` (module-size ratchet); `jobs.rs` is already
//! near its own budget. `populate_entity_job_metadata` lazily resolves an
//! `EntityJob`'s GlobalId / Name / ProductDefinitionShape plus the derived colour
//! and presentation-layer, memoized per ProductDefinitionShape id. Native builds
//! resolve this up front in the parallel scan, so the function is wasm-only.

use super::*;

// Only invoked on the wasm32 serial path; dead on the native build.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
// Threads the full metadata-resolution context; splitting it would not improve clarity.
#[allow(clippy::too_many_arguments)]
pub(super) fn populate_entity_job_metadata(
    job: &mut EntityJob,
    geometry_style_index: &FxHashMap<u32, GeometryStyleInfo>,
    element_material_color: &FxHashMap<u32, [f32; 4]>,
    layer_by_assigned_representation: &FxHashMap<u32, String>,
    color_cache_by_product_definition_shape: &mut FxHashMap<u32, Option<[f32; 4]>>,
    layer_cache_by_product_definition_shape: &mut FxHashMap<u32, Option<String>>,
    layer_cache_by_representation: &mut FxHashMap<u32, Option<String>>,
    decoder: &mut EntityDecoder,
    include_presentation_layers: bool,
) {
    if job.global_id.is_some() || job.name.is_some() || job.product_definition_shape_id.is_some() {
        return;
    }

    let Ok(entity) = decoder.decode_at(job.start, job.end) else {
        return;
    };

    job.global_id = normalize_optional_string(entity.get_string(0));
    job.name = normalize_optional_string(entity.get_string(2));
    job.product_definition_shape_id = entity.get_ref(6);

    let Some(product_definition_shape_id) = job.product_definition_shape_id else {
        return;
    };

    let resolved_color = color_cache_by_product_definition_shape
        .entry(product_definition_shape_id)
        .or_insert_with(|| {
            resolve_element_color_for_product_definition_shape(
                product_definition_shape_id,
                geometry_style_index,
                decoder,
            )
        });
    if let Some(color) = resolved_color {
        job.element_color = *color;
    } else if let Some(color) = element_material_color.get(&job.id) {
        job.element_color = *color;
    }

    if include_presentation_layers {
        let resolved_layer = layer_cache_by_product_definition_shape
            .entry(product_definition_shape_id)
            .or_insert_with(|| {
                resolve_presentation_layer_for_product_definition_shape(
                    product_definition_shape_id,
                    layer_by_assigned_representation,
                    layer_cache_by_representation,
                    decoder,
                )
            });
        job.presentation_layer = resolved_layer.clone();
    }
}
