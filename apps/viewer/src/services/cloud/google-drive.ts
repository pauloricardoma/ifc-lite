/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser-side Google Drive provider. Auth/connection lifecycle lives in
 * `OAuthCloudProvider`; this class implements Drive v3's folder-listing and
 * download shape. Files stream directly from Google to the browser.
 *
 * Drive identifies items by opaque file id rather than path, so folder entries
 * carry the folder id in `CloudFileEntry.path` (what `listFolder` is called
 * with). The empty root path maps to Drive's `'root'` alias.
 */

import {
  type CloudDownloadProgress,
  type CloudFileEntry,
  isSupportedCloudFile,
} from './types.js';
import { OAuthCloudProvider, readBodyWithProgress } from './oauth-provider-base.js';

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_ID = 'root';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

export class GoogleDriveProvider extends OAuthCloudProvider {
  readonly id = 'google';
  readonly label = 'Google Drive';

  async listFolder(path: string): Promise<CloudFileEntry[]> {
    const accessToken = await this.getAccessToken();
    const folderId = path || ROOT_ID;
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(FILES_URL);
      url.searchParams.set('q', `'${folderId}' in parents and trashed = false`);
      url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,modifiedTime)');
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('orderBy', 'folder,name');
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.status === 401) throw this.notConnected();
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Google Drive list failed (${res.status}): ${detail}`);
      }
      const data = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);

    return files
      .filter((f) => f.mimeType === FOLDER_MIME || isSupportedCloudFile(f.name))
      .map((f) => this.toEntry(f))
      .sort((a, b) => {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
  }

  private toEntry(file: DriveFile): CloudFileEntry {
    const isFolder = file.mimeType === FOLDER_MIME;
    return {
      id: file.id,
      name: file.name,
      // Folders are navigated by id; files are downloaded by id too.
      path: file.id,
      size: file.size ? Number(file.size) : 0,
      isFolder,
      modifiedMs: file.modifiedTime ? Date.parse(file.modifiedTime) : null,
    };
  }

  async download(entry: CloudFileEntry, onProgress?: CloudDownloadProgress): Promise<File> {
    const accessToken = await this.getAccessToken();
    const url = new URL(`${FILES_URL}/${encodeURIComponent(entry.id)}`);
    url.searchParams.set('alt', 'media');
    url.searchParams.set('supportsAllDrives', 'true');

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 401) throw this.notConnected();
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Google Drive download failed (${res.status}): ${detail}`);
    }

    const total = entry.size || Number(res.headers.get('content-length')) || null;
    const blob = await readBodyWithProgress(res, total, onProgress);
    return new File([blob], entry.name, { type: 'application/x-step' });
  }
}

/** Shared singleton used by the importer UI. */
export const googleDriveProvider = new GoogleDriveProvider();
