/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { BUILTIN_PANEL_IDS, createDefaultWorkbenchLayout } from '@ifc-lite/extensions';
import { createReviewWorkspaceTemplate, simulateWorkbenchPatch, validateCustomizationPlan } from './index.js';

describe('@ifc-lite/customization', () => {
  it('simulates a workbench patch and summarizes changes', () => {
    const layout = createDefaultWorkbenchLayout();
    const template = createReviewWorkspaceTemplate('2026-01-01T00:00:00.000Z');
    const patch = template.plan.patch;
    if (!patch) throw new Error('template should include patch');
    const result = simulateWorkbenchPatch(layout, patch);
    expect(result.ok).toBe(true);
    expect(result.next.zones.bottom).toContain(BUILTIN_PANEL_IDS.ids);
    expect(result.changes.some((change) => change.operation === 'movePanel')).toBe(true);
  });

  it('validates plan shape', () => {
    const template = createReviewWorkspaceTemplate('2026-01-01T00:00:00.000Z');
    expect(validateCustomizationPlan(template.plan)).toEqual([]);
    expect(validateCustomizationPlan({ ...template.plan, patch: undefined, widget: undefined })).toContain(
      'Plan must include a workbench patch or widget.',
    );
  });
});
