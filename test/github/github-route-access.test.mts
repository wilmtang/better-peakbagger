// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithubRouteTable } from '../../src/background/github-routes.ts';

test('every GitHub route must declare its access policy beside its handler', () => {
    const extensionHandler = () => 'extension';
    const peakbaggerHandler = () => 'peakbagger';
    const table = createGithubRouteTable({
        EXTENSION_ROUTE: { handler: extensionHandler, extensionOnly: true },
        PEAKBAGGER_ROUTE: { handler: peakbaggerHandler, extensionOnly: false },
    });

    assert.equal(table.handlers.EXTENSION_ROUTE, extensionHandler);
    assert.equal(table.handlers.PEAKBAGGER_ROUTE, peakbaggerHandler);
    assert.equal(table.isExtensionOnly('EXTENSION_ROUTE'), true);
    assert.equal(table.isExtensionOnly('PEAKBAGGER_ROUTE'), false);
    assert.equal(table.isExtensionOnly('UNKNOWN_ROUTE'), false);

    // Malformed tables on purpose: the runtime check is what is under test.
    type Routes = Parameters<typeof createGithubRouteTable>[0];
    assert.throws(() => createGithubRouteTable({ UNCLASSIFIED: () => {} } as unknown as Routes),
        /must declare its access policy/);
    assert.throws(() => createGithubRouteTable({ MISSING_HANDLER: { extensionOnly: true } } as unknown as Routes),
        /must declare its access policy/);
});
