/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { xxhash64 } from '@ifc-lite/cache';

/**
 * Spread-sampled source fingerprint — the collision-safe content identity that
 * both keys the persisted cache and VALIDATES a hit (`buildGeometryCacheKey`
 * folds {@link SourceFingerprint.hex} into the key, so a key match *is* the
 * validation). It replaces the old first-4KB+last-4KB FNV-32 fingerprint, which
 * ignored the entire interior of the file and only had 32 bits of entropy.
 *
 * ## Why this removes the repeat-open stall
 * The mesh-only cache tier does not persist the >150MB source, so it used to
 * recompute a full-file `xxhash64` on every repeat open to validate the hit
 * against the header hash — a 0.7-1.7s PURE-JS main-thread stall that scaled
 * with file size. This samples a fixed ~100KB spread regardless of file size
 * (O(1) in the file length, sub-millisecond even on a 400MB file), so making
 * the KEY the validation lets us drop the full-file hash entirely: no stall on
 * read, and no full-file hash on write either (the writer stores {@link
 * SourceFingerprint.hash} in its header cheaply — see `useIfcCache.saveToCache`).
 *
 * ## Why the key match is collision-safe
 * The cache key is `ifc-{exactByteLength}-{hex}-v{fmt}...`, so a stale hit needs
 * a genuinely DIFFERENT file that matches on ALL of:
 *   1. exact byte length (to the byte — folded into both the key and the hash),
 *   2. the first {@link HEAD_TAIL_BYTES} (the ISO-10303-21 header, FILE_NAME
 *      timestamp/author, FILE_SCHEMA, and start of DATA — essentially unique per
 *      model),
 *   3. the last {@link HEAD_TAIL_BYTES} (tail entities + ENDSEC/END-ISO),
 *   4. {@link INTERIOR_WINDOWS} interior windows at fixed fractional offsets, and
 *   5. a 64-bit xxhash collision over the concatenated sample.
 * Requiring all of that simultaneously for two real IFC files is astronomically
 * impossible — far beyond the ~2^-64 of the hash alone. This is strictly
 * stronger than the old key (proved by `sourceFingerprint.test.ts`: a pair that
 * collides on the old weak key is distinguished here), which also closes a
 * latent hazard in the source-persisting tier where an old-key collision could
 * have paired one file's cached geometry with another file's persisted source.
 */
export interface SourceFingerprint {
  /** Filename-safe hex of {@link hash} — the content component of the cache key. */
  hex: string;
  /**
   * The same value as a 64-bit int, for the cache header's `sourceHash` field
   * (passed to `BinaryCacheWriter.write({ sourceHash })` so the write path never
   * pays a full-file hash). It is a cheap content hash, not the full-file hash.
   */
  hash: bigint;
}

/** Bytes sampled from each end of the file (head + tail). */
export const HEAD_TAIL_BYTES = 64 * 1024;
/** Size of each evenly-spaced interior sample window. */
export const INTERIOR_WINDOW_BYTES = 4 * 1024;
/** Number of interior windows sampled between the head and the tail. */
export const INTERIOR_WINDOWS = 8;

/**
 * Compute the {@link SourceFingerprint} for a source buffer. Touches at most
 * `8 + 2*HEAD_TAIL_BYTES + INTERIOR_WINDOWS*INTERIOR_WINDOW_BYTES` (~160KB)
 * regardless of file size, so it is constant-time in the file length.
 */
export function computeSourceFingerprint(buffer: ArrayBuffer | Uint8Array): SourceFingerprint {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const len = view.length;

  const parts: Uint8Array[] = [];

  // 8-byte little-endian length prefix folds the exact size into the hash (it is
  // also a distinct key component, so a length change alone always misses).
  const lenBuf = new Uint8Array(8);
  new DataView(lenBuf.buffer).setBigUint64(0, BigInt(len), true);
  parts.push(lenBuf);

  // Head window.
  parts.push(view.subarray(0, Math.min(HEAD_TAIL_BYTES, len)));

  // Tail window (only when it does not overlap the head).
  if (len > HEAD_TAIL_BYTES) {
    parts.push(view.subarray(Math.max(HEAD_TAIL_BYTES, len - HEAD_TAIL_BYTES), len));
  }

  // Interior windows at evenly spaced fractional offsets i/(N+1), clamped to
  // stay inside the buffer. On small files these overlap the head/tail — that is
  // fine (the head/tail already fully cover a small file's content).
  for (let i = 1; i <= INTERIOR_WINDOWS; i++) {
    const center = Math.floor((len * i) / (INTERIOR_WINDOWS + 1));
    const maxStart = Math.max(0, len - INTERIOR_WINDOW_BYTES);
    const start = Math.min(Math.max(0, center - (INTERIOR_WINDOW_BYTES >> 1)), maxStart);
    parts.push(view.subarray(start, Math.min(start + INTERIOR_WINDOW_BYTES, len)));
  }

  // Concatenate the windows into one contiguous sample for a single hash pass.
  let total = 0;
  for (const p of parts) total += p.length;
  const sample = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    sample.set(p, off);
    off += p.length;
  }

  const hash = xxhash64(sample);
  return { hex: hash.toString(16), hash };
}
