/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser-side Dropbox provider. Auth/connection lifecycle lives in
 * `OAuthCloudProvider`; this class only implements Dropbox's folder-listing and
 * download REST shape. Files stream directly from Dropbox to the browser.
 */

import {
  type CloudDownloadProgress,
  type CloudFileEntry,
  isSupportedCloudFile,
} from './types.js';
import { OAuthCloudProvider, readBodyWithProgress } from './oauth-provider-base.js';

const LIST_FOLDER_URL = 'https://api.dropboxapi.com/2/files/list_folder';
const LIST_FOLDER_CONTINUE_URL = 'https://api.dropboxapi.com/2/files/list_folder/continue';
const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';

/** Serialize a Dropbox-API-Arg value, escaping any non-ASCII to `\uXXXX`. */
function dropboxApiArg(arg: Record<string, unknown>): string {
  return JSON.stringify(arg).replace(/[\u007f-\uffff]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
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

export class DropboxProvider extends OAuthCloudProvider {
  readonly id = 'dropbox';
  readonly label = 'Dropbox';

  async listFolder(path: string): Promise<CloudFileEntry[]> {
    const accessToken = await this.getAccessToken();
    const entries: DropboxMetadata[] = [];

    let res = await fetch(LIST_FOLDER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      // Dropbox wants "" for the root, "/Sub/Folder" otherwise.
      body: JSON.stringify({ path, recursive: false, limit: 2000 }),
    });
    let page = await this.readListPage(res);
    entries.push(...page.entries);

    while (page.has_more && page.cursor) {
      res = await fetch(LIST_FOLDER_CONTINUE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
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
    if (res.status === 401) throw this.notConnected();
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
        // Dropbox content API takes its args as an HTTP header, which must be
        // ASCII. Address the file by its id (always ASCII) rather than its path
        // — a path with non-ASCII characters would make fetch reject the header
        // before sending. `dropboxApiArg` also \u-escapes as a belt-and-braces.
        'Dropbox-API-Arg': dropboxApiArg({ path: entry.id }),
      },
    });
    if (res.status === 401) throw this.notConnected();
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Dropbox download failed (${res.status}): ${detail}`);
    }

    const total = entry.size || Number(res.headers.get('content-length')) || null;
    const blob = await readBodyWithProgress(res, total, onProgress);
    return new File([blob], entry.name, { type: 'application/x-step' });
  }
}

/** Shared singleton used by the importer UI. */
export const dropboxProvider = new DropboxProvider();
