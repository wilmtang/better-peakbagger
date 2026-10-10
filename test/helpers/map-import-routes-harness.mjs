// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';

export const createMapImportHarness = (
    { createRoutes, permission, action },
    { outcome = { ok: true, supplied: true, code: 'prepared', message: 'Ready.' }, redirectUrl } = {},
) => {
    const tabs = new Map();
    const created = [];
    const injections = [];
    const consumed = [];
    let nextId = 20;
    const ext = {
        permissions: {
            request: async request => { assert.deepEqual(request, permission); return true; },
            contains: async request => { assert.deepEqual(request, permission); return true; },
        },
        runtime: { getURL: path => `moz-extension://test/${path}` },
        tabs: {
            create: async details => {
                created.push(details);
                const tab = {
                    id: nextId++,
                    windowId: details.windowId,
                    url: redirectUrl || details.url,
                    status: 'complete',
                };
                tabs.set(tab.id, tab);
                return { ...tab };
            },
            get: async id => ({ ...tabs.get(id) }),
            update: async () => {},
        },
        windows: { update: async () => {} },
        scripting: {
            executeScript: async details => { injections.push(details); return [{ result: outcome }]; },
        },
    };
    const routes = createRoutes({
        ext,
        isPeakbaggerSender: value => value?.url?.startsWith('https://www.peakbagger.com/'),
        trustedActions: {
            consumeGrant: async (...args) => { consumed.push(args); return true; },
        },
        action,
    });
    return { ext, routes, created, injections, consumed };
};
