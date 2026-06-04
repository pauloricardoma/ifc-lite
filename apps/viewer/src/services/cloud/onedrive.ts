/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser-side OneDrive provider (Microsoft Graph). Auth/connection lifecycle
 * lives in `OAuthCloudProvider`; this class implements Graph's folder-listing
 * and download shape. Files stream directly from Microsoft to the browser.
 *
 * Graph identifies items by opaque id, so folder entries carry the item id in
 * `CloudFileEntry.path` (what `listFolder` is called with); the empty root path
 * maps to `/me/drive/root`.
 *
 * Scope note: this browses the user's OneDrive (`/me/drive`), which also
 * surfaces files and SharePoint-library items shared with them. Browsing
 * SharePoint *sites* directly (`/sites/…`) is a planned follow-up — see
 * `docs/guide/cloud-import.md`.
 */

import {
  type CloudDownloadProgress,
  type CloudFileEntry,
  isSupportedCloudFile,
} from './types.js';
import { OAuthCloudProvider, readBodyWithProgress, readErrorBody } from './oauth-provider-base.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SELECT = '$select=id,name,size,folder,file,lastModifiedDateTime';

interface GraphItem {
  id: string;
  name: string;
  size?: number;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  lastModifiedDateTime?: string;
}

interface GraphChildren {
  value?: GraphItem[];
  '@odata.nextLink'?: string;
}

export class OneDriveProvider extends OAuthCloudProvider {
  readonly id = 'onedrive';
  readonly label = 'OneDrive';

  async listFolder(path: string): Promise<CloudFileEntry[]> {
    const accessToken = await this.getAccessToken();
    const items: GraphItem[] = [];
    let next: string | undefined = path
      ? `${GRAPH}/me/drive/items/${encodeURIComponent(path)}/children?${SELECT}&$top=200`
      : `${GRAPH}/me/drive/root/children?${SELECT}&$top=200`;

    while (next) {
      const res: Response = await fetch(next, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.status === 401) throw this.notConnected();
      if (!res.ok) {
        const detail = await readErrorBody(res, this.id);
        throw new Error(`OneDrive list failed (${res.status}): ${detail}`);
      }
      const data = (await res.json()) as GraphChildren;
      items.push(...(data.value ?? []));
      // nextLink is an absolute URL that already carries the bearer-less query.
      next = data['@odata.nextLink'];
    }

    return items
      .filter((it) => Boolean(it.folder) || isSupportedCloudFile(it.name))
      .map((it) => this.toEntry(it))
      .sort((a, b) => {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
  }

  private toEntry(item: GraphItem): CloudFileEntry {
    return {
      id: item.id,
      name: item.name,
      path: item.id,
      size: item.size ?? 0,
      isFolder: Boolean(item.folder),
      modifiedMs: item.lastModifiedDateTime ? Date.parse(item.lastModifiedDateTime) : null,
    };
  }

  async download(entry: CloudFileEntry, onProgress?: CloudDownloadProgress): Promise<File> {
    const accessToken = await this.getAccessToken();
    // Graph 302-redirects /content to a short-lived pre-authenticated download
    // URL; fetch follows it (and browsers drop the Authorization header on the
    // cross-origin hop, which is fine — the redirect target is pre-signed).
    const res = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(entry.id)}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401) throw this.notConnected();
    if (!res.ok) {
      const detail = await readErrorBody(res, this.id);
      throw new Error(`OneDrive download failed (${res.status}): ${detail}`);
    }

    const total = entry.size || Number(res.headers.get('content-length')) || null;
    const blob = await readBodyWithProgress(res, total, onProgress);
    return new File([blob], entry.name, { type: 'application/x-step' });
  }
}

/** Shared singleton used by the importer UI. */
export const onedriveProvider = new OneDriveProvider();
