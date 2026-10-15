// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { setFirefoxContentViewport, withFirefoxContentViewport } from '../../scripts/firefox-content-viewport.mjs';

test('Firefox viewport transport failures name the requested command and dimensions', async () => {
    const requests = [];
    const driver = { getWindowHandle: async () => 'fixture-context', getBidi: async () => ({ send: async request => {
        requests.push(request);
        throw new Error('Request with id 18 timed out');
    } }) };
    await assert.rejects(setFirefoxContentViewport(driver, { width: 360, height: 760 }),
        /browsingContext.setViewport 360x760 failed: Request with id 18 timed out/);
    assert.deepEqual(requests, [{ method: 'browsingContext.setViewport',
        params: { context: 'fixture-context', viewport: { width: 360, height: 760 } } }]);
});

test('Firefox viewport reset preserves the original assertion when transport cleanup also fails', async () => {
    const primary = new Error('card assertion failed');
    const driver = { getWindowHandle: async () => 'fixture-context', getBidi: async () => ({ send: async () => {
        throw new Error('Request with id 18 timed out');
    } }) };
    await assert.rejects(withFirefoxContentViewport(driver, async () => { throw primary; }), error => {
        assert.equal(error, primary);
        assert.match(error.message, /card assertion failed/);
        assert.match(error.message, /setViewport reset failed/);
        assert.equal(error.cleanupErrors.length, 1);
        return true;
    });
});

test('Firefox viewport scope resets after a successful probe and fails on a rejected reset', async () => {
    const requests = [];
    const driver = { getWindowHandle: async () => 'fixture-context', getBidi: async () => ({ send: async request => {
        requests.push(request);
        return { type: 'success' };
    } }) };
    assert.equal(await withFirefoxContentViewport(driver, async () => 'complete'), 'complete');
    assert.equal(requests[0].params.viewport, null);
    driver.getBidi = async () => ({ send: async () => ({ type: 'error', error: 'invalid argument', message: 'bad viewport' }) });
    await assert.rejects(withFirefoxContentViewport(driver, async () => 'complete'), /setViewport reset failed: invalid argument/);
});
