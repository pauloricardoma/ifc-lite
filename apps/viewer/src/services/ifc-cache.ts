/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IndexedDB cache service for IFC files
 *
 * Stores parsed IFC data and geometry in IndexedDB for fast subsequent loads.
 * Uses xxhash64 of the source file as the cache key.
 */

const DB_NAME = 'ifc-lite-cache';
const DB_VERSION = 1;
const STORE_NAME = 'models';

interface CacheEntry {
  key: string;
  buffer: ArrayBuffer;
  sourceBuffer?: ArrayBuffer; // Original IFC source for on-demand property extraction
  fileName: string;
  fileSize: number;
  createdAt: number;
}

/**
 * Per-entry hard ceiling (1.5GB). A single cache record above this is refused so
 * one pathological model can't blow the whole origin quota. The mesh-only tier
 * caps source at 400MB but its decoded geometry can be larger, so the ceiling is
 * comfortably above that while still catching a runaway blob.
 */
const PER_ENTRY_MAX_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * Free-space headroom to keep below the origin quota after a write, so we never
 * write right up to the limit (a full quota fails future writes app-wide and can
 * trip browser eviction of the whole origin). A fixed 128MB is enough to clear
 * the edge without over-reserving on large quotas.
 */
const QUOTA_HEADROOM_BYTES = 128 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase> | null = null;

/** Bytes a cache record occupies on disk (cache buffer + optional source). */
function entryBytes(buffer: ArrayBuffer, sourceBuffer?: ArrayBuffer): number {
  return buffer.byteLength + (sourceBuffer?.byteLength ?? 0);
}

/**
 * Best-effort free bytes remaining in the origin's storage quota. Returns
 * `Infinity` when the Storage API is unavailable (older Safari / blocked) so the
 * caller falls back to the per-entry ceiling alone rather than refusing writes.
 */
async function availableQuotaBytes(): Promise<number> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const { quota, usage } = await navigator.storage.estimate();
      if (typeof quota === 'number' && typeof usage === 'number') {
        return Math.max(0, quota - usage);
      }
    }
  } catch (err) {
    console.warn('[IFC Cache] storage.estimate() failed; skipping quota guard', err);
  }
  return Infinity;
}

/**
 * Evict least-recently-created entries (oldest `createdAt` first) until at least
 * `targetBytes` have been freed or the store is exhausted, skipping `keepKey`
 * (the entry we're about to (over)write). Returns the bytes actually freed.
 */
function evictOldestUntilFreed(db: IDBDatabase, targetBytes: number, keepKey: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const cursorReq = store.index('createdAt').openCursor(); // ascending = oldest first
    let freed = 0;

    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || freed >= targetBytes) return; // done; tx will complete
      const entry = cursor.value as CacheEntry;
      if (entry.key !== keepKey) {
        freed += entryBytes(entry.buffer, entry.sourceBuffer);
        cursor.delete();
      }
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
    tx.oncomplete = () => resolve(freed);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Make room for a `bytes`-sized entry: refuse oversized records, then (if the
 * Storage API reports a tight quota) LRU-evict older entries until it fits.
 * Returns `true` when the write should proceed, `false` when it must be skipped.
 */
async function ensureRoomForEntry(db: IDBDatabase, bytes: number, keepKey: string): Promise<boolean> {
  if (bytes > PER_ENTRY_MAX_BYTES) {
    console.warn(`[IFC Cache] Entry ${(bytes / 1024 / 1024).toFixed(0)}MB exceeds per-entry ceiling; skipping cache write`);
    return false;
  }

  const available = await availableQuotaBytes();
  if (available === Infinity) return true; // no quota signal — rely on the ceiling
  const required = bytes + QUOTA_HEADROOM_BYTES;
  if (available >= required) return true;

  const need = required - available;
  let freed = 0;
  try {
    freed = await evictOldestUntilFreed(db, need, keepKey);
  } catch (err) {
    console.warn('[IFC Cache] LRU eviction failed; skipping cache write', err);
    return false;
  }
  if (available + freed >= required) return true;

  console.warn(`[IFC Cache] Insufficient quota headroom (need ${(need / 1024 / 1024).toFixed(0)}MB, freed ${(freed / 1024 / 1024).toFixed(0)}MB); skipping cache write`);
  return false;
}

/**
 * Open the IndexedDB database
 */
function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[IFC Cache] Failed to open database:', request.error);
      dbPromise = null; // Reset so we can retry
      reject(request.error);
    };

    request.onsuccess = () => {
      const db = request.result;
      
      // Verify the object store exists (handles corrupted DB state)
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        console.warn('[IFC Cache] Object store missing, recreating database...');
        db.close();
        dbPromise = null;
        
        // Delete and recreate the database
        const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
        deleteRequest.onsuccess = () => {
          // Retry opening after deletion
          openDatabase().then(resolve).catch(reject);
        };
        deleteRequest.onerror = () => {
          reject(new Error('Failed to recreate database'));
        };
        return;
      }
      
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create object store for cached models
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('fileName', 'fileName', { unique: false });
      }
    };
  });

  return dbPromise;
}

export interface CacheResult {
  buffer: ArrayBuffer;
  sourceBuffer?: ArrayBuffer;
}

/**
 * Get a cached model by hash key
 */
export async function getCached(key: string): Promise<CacheResult | null> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        const entry = request.result as CacheEntry | undefined;
        if (entry) {
          resolve({
            buffer: entry.buffer,
            sourceBuffer: entry.sourceBuffer,
          });
        } else {
          resolve(null);
        }
      };

      request.onerror = () => {
        console.error('[IFC Cache] Failed to get cache entry:', request.error);
        reject(request.error);
      };
    });
  } catch (err) {
    console.warn('[IFC Cache] Cache read failed:', err);
    return null;
  }
}

/**
 * Store a model in the cache
 */
export async function setCached(
  key: string,
  buffer: ArrayBuffer,
  fileName: string,
  fileSize: number,
  sourceBuffer?: ArrayBuffer
): Promise<void> {
  try {
    const db = await openDatabase();

    // Quota/eviction guard (prerequisite for the mesh-only tier — entries can be
    // 100s of MB): refuse oversized records and LRU-evict older entries when the
    // origin quota is tight, so a large write can't blow the quota app-wide.
    const roomOk = await ensureRoomForEntry(db, entryBytes(buffer, sourceBuffer), key);
    if (!roomOk) return; // non-fatal: a cache miss next open is a slow load, not a crash

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const entry: CacheEntry = {
        key,
        buffer,
        sourceBuffer,
        fileName,
        fileSize,
        createdAt: Date.now(),
      };

      const request = store.put(entry);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        console.error('[IFC Cache] Failed to cache entry:', request.error);
        reject(request.error);
      };
    });
  } catch (err) {
    console.warn('[IFC Cache] Cache write failed:', err);
  }
}

/**
 * Check if a cache entry exists
 */
export async function hasCached(key: string): Promise<boolean> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.count(IDBKeyRange.only(key));

      request.onsuccess = () => {
        resolve(request.result > 0);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch {
    return false;
  }
}

/**
 * Delete a cache entry
 */
export async function deleteCached(key: string): Promise<void> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('[IFC Cache] Failed to delete cache entry:', err);
  }
}

/**
 * Clear all cached models
 */
export async function clearCache(): Promise<void> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('[IFC Cache] Failed to clear cache:', err);
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
  entryCount: number;
  totalSize: number;
  entries: Array<{ fileName: string; fileSize: number; createdAt: Date }>;
}> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const entries = request.result as CacheEntry[];
        resolve({
          entryCount: entries.length,
          totalSize: entries.reduce((sum, e) => sum + e.buffer.byteLength, 0),
          entries: entries.map((e) => ({
            fileName: e.fileName,
            fileSize: e.fileSize,
            createdAt: new Date(e.createdAt),
          })),
        });
      };

      request.onerror = () => reject(request.error);
    });
  } catch {
    return { entryCount: 0, totalSize: 0, entries: [] };
  }
}
