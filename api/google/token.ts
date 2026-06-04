/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getHandlers, notConfigured } from './_shared.js';

export const runtime = 'edge';
export const config = { runtime: 'edge' };

export default function handler(req: Request): Promise<Response> | Response {
  const handlers = getHandlers();
  if (!handlers) return notConfigured();
  return handlers.token(req);
}
