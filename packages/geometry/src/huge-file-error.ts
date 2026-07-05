/**
 * Turn the bare wasm trap a huge model triggers in the streaming prepass into an
 * actionable, human-readable error.
 *
 * The streaming prepass (`buildPrePassStreaming`) copies the whole file into
 * wasm linear memory AND builds the entity index alongside it. On wasm32 the
 * address space is capped at 4GB, so a ~3GB+ file cannot fit — the allocator
 * aborts with a bare `unreachable executed` / `RuntimeError`. This maps that to
 * a clear message pointing at the desktop app (which is 64-bit, no such limit).
 */

/** Below this the failure is treated as unrelated to size (caller rethrows). */
const HUGE_FILE_GB_THRESHOLD = 2.5;

/** wasm OOM / abort signatures across engines (V8, SpiderMonkey, JSC). */
const OOM_SIGNATURE =
  /unreachable|out of memory|memory access|RuntimeError|allocat|enlarge memory|grow memory|could not allocate/i;

/**
 * Returns a clear error when `err` looks like a wasm OOM trap on a large file,
 * else `null` (the caller then rethrows the original error unchanged).
 */
export function largeFilePrepassError(err: unknown, byteLength: number): Error | null {
  const sizeGB = byteLength / 1e9;
  const msg = err instanceof Error ? err.message : String(err);
  if (sizeGB >= HUGE_FILE_GB_THRESHOLD && OOM_SIGNATURE.test(msg)) {
    return new Error(
      `This model is ${sizeGB.toFixed(1)} GB, which exceeds the browser's ~3 GB WebAssembly memory ` +
        `ceiling (32-bit address space). Open it in the ifc-lite desktop app, which has no such limit.`,
    );
  }
  return null;
}
