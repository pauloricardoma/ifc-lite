/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser-side OneDrive / SharePoint provider (Microsoft Graph). Auth/connection
 * lifecycle lives in `OAuthCloudProvider`; this class implements Graph's
 * folder-listing and download shape. Files stream directly from Microsoft to the
 * browser.
 *
 * Navigation spans two sources behind one tree. `CloudFileEntry.path` carries a
 * small structured token so any item resolves to the right Graph endpoint:
 *
 *   ''                       → virtual root: "My OneDrive" + followed SharePoint sites
 *   'me-root'                → /me/drive/root/children
 *   'site:<siteId>'          → /sites/<siteId>/drive/root/children  (default library)
 *   'dl:<driveId>:<itemId>'  → /drives/<driveId>/items/<itemId>/children  (and /content)
 *
 * Real files always arrive as `dl:` entries (they carry their drive id), so a
 * single download path serves both OneDrive and SharePoint. Browsing additional
 * (non-default) document libraries per site is a possible follow-up.
 */

import {
  type CloudDownloadProgress,
  type CloudFileEntry,
  isSupportedCloudFile,
} from './types.js';
import { OAuthCloudProvider, readBodyWithProgress, readErrorBody } from './oauth-provider-base.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SELECT = '$select=id,name,size,folder,file,lastModifiedDateTime,parentReference';

interface GraphItem {
  id: string;
  name: string;
  size?: number;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  lastModifiedDateTime?: string;
  parentReference?: { driveId?: string };
}

interface GraphChildren {
  value?: GraphItem[];
  '@odata.nextLink'?: string;
}

interface GraphSite {
  id: string;
  displayName?: string;
  name?: string;
}

export class OneDriveProvider extends OAuthCloudProvider {
  readonly id = 'onedrive';
  readonly label = 'OneDrive / SharePoint';

  async listFolder(path: string): Promise<CloudFileEntry[]> {
    if (path === '') return this.listRoot();
    if (path === 'me-root') return this.listChildren(`${GRAPH}/me/drive/root/children`);
    if (path.startsWith('site:')) {
      return this.listChildren(`${GRAPH}/sites/${encodeURIComponent(path.slice(5))}/drive/root/children`);
    }
    if (path.startsWith('dl:')) {
      const { driveId, itemId } = parseDriveRef(path);
      return this.listChildren(
        `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children`,
      );
    }
    throw new Error(`OneDrive: unrecognized path "${path}"`);
  }

  /** Virtual root: the user's OneDrive plus any SharePoint sites they follow. */
  private async listRoot(): Promise<CloudFileEntry[]> {
    const entries: CloudFileEntry[] = [
      { id: 'me-root', name: 'My OneDrive', path: 'me-root', size: 0, isFolder: true, modifiedMs: null },
    ];
    for (const site of await this.fetchFollowedSites()) {
      entries.push({
        id: `site:${site.id}`,
        name: site.displayName || site.name || 'SharePoint site',
        path: `site:${site.id}`,
        size: 0,
        isFolder: true,
        modifiedMs: null,
      });
    }
    return entries;
  }

  /** Followed SharePoint sites. Degrades to an empty list if the scope is absent. */
  private async fetchFollowedSites(): Promise<GraphSite[]> {
    const accessToken = await this.getAccessToken();
    const res = await fetch(`${GRAPH}/me/followedSites?$select=id,displayName,name`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401) throw this.notConnected();
    if (!res.ok) {
      // 403 when Sites.Read.All wasn't consented — still usable for OneDrive.
      console.warn(`[onedrive] could not list followed SharePoint sites (${res.status})`);
      return [];
    }
    const data = (await res.json()) as { value?: GraphSite[] };
    return data.value ?? [];
  }

  /** Page through a Graph children endpoint and map to sorted cloud entries. */
  private async listChildren(firstUrl: string): Promise<CloudFileEntry[]> {
    const accessToken = await this.getAccessToken();
    const items: GraphItem[] = [];
    let next: string | undefined = `${firstUrl}?${SELECT}&$top=200`;

    while (next) {
      const res: Response = await fetch(next, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.status === 401) throw this.notConnected();
      if (!res.ok) {
        const detail = await readErrorBody(res, this.id);
        throw new Error(`OneDrive list failed (${res.status}): ${detail}`);
      }
      const data = (await res.json()) as GraphChildren;
      items.push(...(data.value ?? []));
      // nextLink is an absolute URL that already carries the query.
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
    const driveId = item.parentReference?.driveId ?? '';
    return {
      id: item.id,
      name: item.name,
      // Drive-qualified ref so folders navigate and files download uniformly.
      path: `dl:${driveId}:${item.id}`,
      size: item.size ?? 0,
      isFolder: Boolean(item.folder),
      modifiedMs: item.lastModifiedDateTime ? Date.parse(item.lastModifiedDateTime) : null,
    };
  }

  async download(entry: CloudFileEntry, onProgress?: CloudDownloadProgress): Promise<File> {
    const accessToken = await this.getAccessToken();
    const { driveId, itemId } = parseDriveRef(entry.path);
    // Graph 302-redirects /content to a short-lived pre-authenticated download
    // URL; fetch follows it (and browsers drop the Authorization header on the
    // cross-origin hop, which is fine — the redirect target is pre-signed).
    const res = await fetch(
      `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
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

/** Parse a `dl:<driveId>:<itemId>` token. The item id may itself contain colons. */
function parseDriveRef(path: string): { driveId: string; itemId: string } {
  const body = path.slice('dl:'.length);
  const sep = body.indexOf(':');
  if (sep === -1) throw new Error(`OneDrive: malformed drive ref "${path}"`);
  return { driveId: body.slice(0, sep), itemId: body.slice(sep + 1) };
}

/** Shared singleton used by the importer UI. */
export const onedriveProvider = new OneDriveProvider();
