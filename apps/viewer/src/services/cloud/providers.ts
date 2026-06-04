/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Registry of available cloud storage providers. The importer UI iterates this
 * list, so adding a provider is a one-line change here plus its `/api/<id>/*`
 * routes and a `*_CLIENT_ID`/`*_SECRET` env pair.
 */

import type { CloudProvider } from './types.js';
import { dropboxProvider } from './dropbox.js';
import { googleDriveProvider } from './google-drive.js';
import { onedriveProvider } from './onedrive.js';

export const cloudProviders: readonly CloudProvider[] = [
  dropboxProvider,
  googleDriveProvider,
  onedriveProvider,
];
