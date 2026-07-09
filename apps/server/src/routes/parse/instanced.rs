// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Instanced geometry endpoint — geometria ÚNICA (templates) + ocorrências.
//!
//! Liga `StreamingOptions.enable_instancing` (default é `false`): as ocorrências
//! repetidas de um `IfcRepresentationMap` NÃO materializam a geometria cheia
//! (don't-bake, #1623). O template fica em `result.meshes` (geometria única, 1×)
//! e cada ocorrência vira um `InstanceRecord` (transform template-relativo) em
//! `result.instances`. Aqui serializamos só os templates (parquet compacto) e
//! reportamos a contagem de ocorrências — o que mede o tamanho real com dedup.
//!
//! Módulo isolado (manutenção do fork): só consome APIs públicas do ifc-lite.

use super::extract_file;
use crate::error::ApiError;
use crate::services::serialize_to_parquet;
use crate::AppState;
use axum::{
    body::Body,
    extract::{Multipart, State},
    http::header,
    response::Response,
};
use ifc_lite_processing::{process_geometry_streaming_with_options, StreamingOptions};

/// POST /api/v1/parse/instanced — geometria única (templates) em parquet compacto.
///
/// - Content-Type: `application/x-parquet-geometry` (só os templates únicos)
/// - Headers: `X-Templates`, `X-Occurrences`, `X-Template-Parquet`, `X-Est-Total`, `X-Ms`
/// - Body: parquet dos templates (geometria única) — deduplicada por instância
pub async fn parse_instanced(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Response, ApiError> {
    let content = extract_file(&mut multipart, state.config.max_file_size_mb).await?;
    let t0 = std::time::Instant::now();

    let (parquet, templates, occurrences, coord_space) = tokio::task::spawn_blocking(move || {
        let result = process_geometry_streaming_with_options(
            content.as_ref(),
            StreamingOptions {
                enable_instancing: true, // <- o pulo do gato (default é false)
                retain_emitted_meshes: true,
                initial_batch_size: usize::MAX,
                throughput_batch_size: usize::MAX,
                ..StreamingOptions::default()
            },
            |_, _, _| {},
            |_| {},
        );
        let templates = result.meshes.len();
        let occurrences = result.instances.len();
        let coord_space = result
            .mesh_coordinate_space
            .clone()
            .unwrap_or_else(|| "unknown".into());
        // Serializa só a geometria ÚNICA (templates). As ocorrências são só
        // transforms (InstanceRecord), não geometria.
        let parquet = serialize_to_parquet(&result.meshes);
        (parquet, templates, occurrences, coord_space)
    })
    .await
    .map_err(|e| ApiError::Internal(format!("instanced task failed: {e}")))?;

    let parquet = parquet.map_err(|e| ApiError::Internal(e.to_string()))?;
    let ms = t0.elapsed().as_millis();
    let template_bytes = parquet.len();
    // Estimativa da tabela de ocorrências: ~88 B cada (express+template id + mat4 f32 + cor).
    let occ_bytes = occurrences * 88;
    let est_total = template_bytes + occ_bytes;

    tracing::info!(
        templates,
        occurrences,
        template_parquet = template_bytes,
        est_total,
        elapsed_ms = ms,
        "Instanced (templates parquet) complete"
    );

    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-parquet-geometry")
        .header("X-Templates", templates.to_string())
        .header("X-Occurrences", occurrences.to_string())
        .header("X-Coord-Space", coord_space)
        .header("X-Template-Parquet", template_bytes.to_string())
        .header("X-Est-Total", est_total.to_string())
        .header("X-Ms", ms.to_string())
        .header(header::CONTENT_LENGTH, template_bytes)
        .body(Body::from(parquet))
        .map_err(|e| ApiError::Internal(e.to_string()))
}
