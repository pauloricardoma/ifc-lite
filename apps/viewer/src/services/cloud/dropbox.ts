/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser-side Dropbox provider.
 *
 * Auth is handled by our serverless routes under `/api/dropbox/*` (the app
 * secret and refresh token stay server-side in an httpOnly cookie). This client
 * only ever holds a short-lived access token in memory, which it uses to call
 * Dropbox directly for folder listing and file download — so IFC bytes stream
 * straight from Dropbox to the browser and never touch our servers.
 *
 * The OAuth consent runs in a popup; completion is signalled back via a
 * same-origin `localStorage` write (the `storage` event), which survives the
 * app's `Cross-Origin-Opener-Policy: same-origin` header — `window.opener` does
 * not.
 */

import {
  type CloudDownloadProgress,
  type CloudFileEntry,
  type CloudProvider,
  isSupportedCloudFile,
} from './types.js';

const CONNECTED_FLAG = 'ifc-lite:dropbox:connected';
const AUTH_RESULT_KEY = 'ifc-lite:dropbox:auth-result';
const LIST_FOLDER_URL = 'https://api.dropboxapi.com/2/files/list_folder';
const LIST_FOLDER_CONTINUE_URL = 'https://api.dropboxapi.com/2/files/list_folder/continue';
const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

interface DropboxMetadata {
  '.tag': 'file' | 'folder' | 'deleted';
  id: string;
  name: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
  server_modified?: string;
}

/** Raised when the user has no live Dropbox connection (re-connect required). */
export class DropboxNotConnectedError extends Error {
  constructor() {
    super('Not connected to Dropbox');
    this.name = 'DropboxNotConnectedError';
  }
}

export class DropboxProvider implements CloudProvider {
  readonly id = 'dropbox';
  readonly label = 'Dropbox';

  private token: CachedToken | null = null;

  isConnected(): boolean {
    try {
      return localStorage.getItem(CONNECTED_FLAG) === '1';
    } catch {
      return false;
    }
  }

  private setConnected(connected: boolean): void {
    try {
      if (connected) localStorage.setItem(CONNECTED_FLAG, '1');
      else localStorage.removeItem(CONNECTED_FLAG);
    } catch (err) {
      console.warn('[dropbox] could not persist connection flag:', err);
    }
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const w = 560;
      const h = 720;
      const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
      const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
      const popup = window.open(
        '/api/dropbox/auth-start',
        'dropbox-oauth',
        `popup,width=${w},height=${h},left=${left},top=${top}`,
      );
      if (!popup) {
        reject(new Error('Popup blocked — allow popups for ifclite.com to connect Dropbox.'));
        return;
      }

      let settled = false;
      const cleanup = () => {
        window.removeEventListener('storage', onStorage);
        clearInterval(closedPoll);
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onStorage = (e: StorageEvent) => {
        if (e.key !== AUTH_RESULT_KEY || !e.newValue) return;
        try {
          const result = JSON.parse(e.newValue) as { ok?: boolean; message?: string };
          localStorage.removeItem(AUTH_RESULT_KEY);
          if (result.ok) {
            this.setConnected(true);
            finish(resolve);
          } else {
            finish(() => reject(new Error(result.message || 'Dropbox connection failed')));
          }
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error('Bad auth result')));
        }
      };
      window.addEventListener('storage', onStorage);

      // Detect the user closing the popup without finishing consent.
      const closedPoll = window.setInterval(() => {
        if (popup.closed) {
          finish(() => reject(new Error('Dropbox connection cancelled')));
        }
      }, 500);
    });
  }

  async disconnect(): Promise<void> {
    this.token = null;
    this.setConnected(false);
    try {
      await fetch('/api/dropbox/disconnect', { method: 'POST', credentials: 'same-origin' });
    } catch (err) {
      // Non-fatal: the local flag is cleared regardless.
      console.warn('[dropbox] disconnect request failed:', err);
    }
  }

  /** Fetch (and cache) a short-lived access token via our serverless route. */
  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.accessToken;
    }
    const res = await fetch('/api/dropbox/token', { method: 'POST', credentials: 'same-origin' });
    if (res.status === 401) {
      this.setConnected(false);
      throw new DropboxNotConnectedError();
    }
    if (!res.ok) {
      throw new Error(`Dropbox token request failed: ${res.status}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    this.setConnected(true);
    return this.token.accessToken;
  }

  async listFolder(path: string): Promise<CloudFileEntry[]> {
    const accessToken = await this.getAccessToken();
    const entries: DropboxMetadata[] = [];

    let res = await fetch(LIST_FOLDER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      // Dropbox wants "" for the root, "/Sub/Folder" otherwise.
      body: JSON.stringify({ path, recursive: false, limit: 2000 }),
    });
    let page = await this.readListPage(res);
    entries.push(...page.entries);

    while (page.has_more && page.cursor) {
      res = await fetch(LIST_FOLDER_CONTINUE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cursor: page.cursor }),
      });
      page = await this.readListPage(res);
      entries.push(...page.entries);
    }

    return entries
      .filter((e) => e['.tag'] === 'folder' || (e['.tag'] === 'file' && isSupportedCloudFile(e.name)))
      .map((e) => this.toEntry(e))
      .sort((a, b) => {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
  }

  private async readListPage(
    res: Response,
  ): Promise<{ entries: DropboxMetadata[]; has_more: boolean; cursor?: string }> {
    if (res.status === 401) {
      this.token = null;
      this.setConnected(false);
      throw new DropboxNotConnectedError();
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Dropbox list_folder failed (${res.status}): ${detail}`);
    }
    const data = (await res.json()) as { entries: DropboxMetadata[]; has_more: boolean; cursor: string };
    return { entries: data.entries ?? [], has_more: Boolean(data.has_more), cursor: data.cursor };
  }

  private toEntry(meta: DropboxMetadata): CloudFileEntry {
    return {
      id: meta.id,
      name: meta.name,
      path: meta.path_lower ?? meta.path_display ?? `/${meta.name}`,
      size: meta.size ?? 0,
      isFolder: meta['.tag'] === 'folder',
      modifiedMs: meta.server_modified ? Date.parse(meta.server_modified) : null,
    };
  }

  async download(entry: CloudFileEntry, onProgress?: CloudDownloadProgress): Promise<File> {
    const accessToken = await this.getAccessToken();
    const res = await fetch(DOWNLOAD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // Dropbox content API takes its args as a header on download.
        'Dropbox-API-Arg': JSON.stringify({ path: entry.path }),
      },
    });
    if (res.status === 401) {
      this.token = null;
      this.setConnected(false);
      throw new DropboxNotConnectedError();
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Dropbox download failed (${res.status}): ${detail}`);
    }

    const total = entry.size || Number(res.headers.get('content-length')) || null;
    const blob = await readBodyWithProgress(res, total, onProgress);
    return new File([blob], entry.name, { type: 'application/x-step' });
  }
}

/** Stream a response body into a Blob, reporting progress as bytes arrive. */
async function readBodyWithProgress(
  res: Response,
  total: number | null,
  onProgress?: CloudDownloadProgress,
): Promise<Blob> {
  if (!res.body || !onProgress) {
    return res.blob();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        onProgress(loaded, total);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks as BlobPart[], { type: 'application/x-step' });
}

/** Shared singleton used by the importer UI. */
export const dropboxProvider = new DropboxProvider();
