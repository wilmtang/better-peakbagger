/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The in-page test runtime itself: Node's strict assertion semantics, fixture
// frames, read-only checkout files, mocked timers and trusted input.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FixtureDom, evalBundle, trustedInput } from '../../helpers/fixture-dom.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('strict equality and deep equality follow node:assert/strict', () => {
    assert.equal(1, 1);
    assert.throws(() => assert.equal(1, '1' as unknown), { name: 'AssertionError' });
    assert.throws(() => assert.equal(0, -0), { name: 'AssertionError' });
    assert.equal(Number.NaN, Number.NaN);
    assert.deepEqual({ a: [1, { b: new Date(5) }], c: new Map([[1, new Set(['x'])]]) },
        { a: [1, { b: new Date(5) }], c: new Map([[1, new Set(['x'])]]) });
    assert.throws(() => assert.deepEqual({ a: 1 }, { a: 1, b: undefined }), { name: 'AssertionError' });
    assert.throws(() => assert.deepEqual([1], { 0: 1, length: 1 }), { name: 'AssertionError' });
    assert.throws(() => assert.deepEqual(new Date(1), new Date(2)), { name: 'AssertionError' });
    assert.throws(() => assert.deepEqual(/a/g, /a/i), { name: 'AssertionError' });
    assert.throws(() => assert.deepEqual(Object.create(null), {}), { name: 'AssertionError' });
    assert.throws(() => assert.match(1 as unknown as string, /1/), { name: 'AssertionError' });
    assert.throws(() => { throw new TypeError('bad value'); }, TypeError);
    assert.throws(() => { throw new TypeError('bad value'); }, /TypeError: bad value/);
    assert.throws(() => assert.throws(() => {}), /Missing expected exception/);
});

test('objects from a fixture realm keep their own prototypes, as they do in Node', t => {
    const dom = new FixtureDom('<!doctype html><body></body>');
    t.after(() => dom.window.close());
    const foreign = dom.window.eval('({ value: 1 })') as object;
    assert.throws(() => assert.deepEqual(foreign, { value: 1 }), { name: 'AssertionError' });
    assert.deepEqual(JSON.parse(JSON.stringify(foreign)), { value: 1 });
});

test('fixture documents keep inline scripts inert and take the requested URL and mode', t => {
    const dom = new FixtureDom('<!doctype html><html><head><title>Fixture</title></head><body><p id="p">text</p>'
        + '<script>window.ran = true; document.body.dataset.ran = "yes";</script></body></html>',
    { url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1' });
    t.after(() => dom.window.close());
    const { window } = dom;
    assert.equal(window.location.href, 'https://www.peakbagger.com/climber/ascent.aspx?aid=1');
    assert.equal(window.document.title, 'Fixture');
    assert.equal(window.document.compatMode, 'CSS1Compat');
    assert.equal((window as unknown as { ran?: boolean }).ran, undefined);
    assert.equal(window.document.body.dataset.ran, undefined);
    assert.equal(window.document.getElementById('p')?.textContent, 'text');
    assert.ok(window.document.body.getBoundingClientRect().width > 0, 'fixture documents have real layout');
    const quirks = new FixtureDom('<p>no doctype</p>');
    t.after(() => quirks.window.close());
    assert.equal(quirks.window.document.compatMode, 'BackCompat');
    assert.throws(() => new FixtureDom('', { url: 'https://evil.example/' }), /@browser-origin https:\/\/evil\.example/);
});

test('closing a fixture window removes its frame', () => {
    const dom = new FixtureDom('<p>x</p>');
    const frames = document.querySelectorAll('iframe').length;
    dom.window.close();
    assert.equal(document.querySelectorAll('iframe').length, frames - 1);
});

test('checkout files and built bundles are readable, and nothing outside the checkout is', async t => {
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as { manifest_version: number };
    assert.equal(manifest.manifest_version, 3);
    const bytes = readFileSync(path.join(root, 'manifest.json')) as Uint8Array;
    assert.equal(bytes[0], '{'.charCodeAt(0));
    assert.equal(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8') as string).manifest_version, 3);
    await assert.rejects(readFile('/etc/hosts', 'utf8'), { code: 'ENOENT' });
    assert.throws(() => readFileSync(path.join(root, '..', 'outside.txt')), { code: 'ENOENT' });
    const dom = new FixtureDom('<!doctype html><body></body>', { url: 'https://www.peakbagger.com/peak.aspx?pid=1' });
    t.after(() => dom.window.close());
    await evalBundle(dom.window, 'content/report-protection.js');
});

test('mocked timers drive the page and fixture windows created before and after enabling', t => {
    const before = new FixtureDom('<p>before</p>');
    t.after(() => before.window.close());
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const after = new FixtureDom('<p>after</p>');
    t.after(() => after.window.close());
    const fired: string[] = [];
    setTimeout(() => fired.push('page'), 100);
    before.window.setTimeout(() => fired.push('before'), 200);
    after.window.setTimeout(() => fired.push('after'), 300);
    t.mock.timers.tick(250);
    assert.deepEqual(fired, ['page', 'before']);
    t.mock.timers.tick(50);
    assert.deepEqual(fired, ['page', 'before', 'after']);
});

test('trusted input reaches fixture frames as real, trusted events', async t => {
    const dom = new FixtureDom('<!doctype html><body><button>Go</button><input id="field"></body>');
    t.after(() => dom.window.close());
    const covering = new FixtureDom('<!doctype html><body style="background:red"></body>');
    t.after(() => covering.window.close());
    const button = dom.window.document.querySelector('button')!;
    const events: boolean[] = [];
    button.addEventListener('click', event => events.push(event.isTrusted));
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await trustedInput(button, { type: 'click' });
    assert.deepEqual(events, [false, true]);
    const field = dom.window.document.querySelector('input')!;
    const keys: string[] = [];
    field.addEventListener('keydown', event => { if (event.isTrusted) keys.push(event.key); });
    await trustedInput(field, { type: 'press', key: 'Enter' });
    assert.deepEqual(keys, ['Enter']);
    assert.equal(dom.window.document.activeElement, field);
});

test('subtests and after hooks run in order', async t => {
    const order: string[] = [];
    t.after(() => { order.push('after'); assert.deepEqual(order, ['one', 'two', 'after']); });
    await t.test('one', () => { order.push('one'); });
    await t.test('two', () => { order.push('two'); });
});

test('same-site fixtures load at their own origin and stay synchronously reachable', async t => {
    const dom = await FixtureDom.open('<!doctype html><body><p id="p">bare host</p><script>window.ran = true;</script></body>',
        { url: 'https://peakbagger.com/report/report.aspx?r=b' });
    t.after(() => dom.window.close());
    assert.equal(dom.window.location.href, 'https://peakbagger.com/report/report.aspx?r=b');
    assert.equal(dom.window.location.origin, 'https://peakbagger.com');
    assert.equal(dom.window.document.getElementById('p')?.textContent, 'bare host');
    assert.equal((dom.window as unknown as { ran?: boolean }).ran, undefined);
    await assert.rejects(FixtureDom.open('', { url: 'https://www.strava.com/' }), /@browser-origin https:\/\/www\.strava\.com/);
});

test('fixture documents resolve relative links against their own URL', t => {
    const dom = new FixtureDom('<!doctype html><a href="climber.aspx?cid=1">x</a>', { url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=1' });
    t.after(() => dom.window.close());
    assert.equal(dom.window.document.baseURI, 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=1');
    assert.equal(dom.window.document.querySelector('a')!.href, 'https://www.peakbagger.com/climber/climber.aspx?cid=1');
    assert.equal(location.pathname, '/__bpb_test__/', 'the test page keeps its own URL');
});

test('fixture markup cannot run code through handler attributes or javascript: URLs', async t => {
    const dom = new FixtureDom('<!doctype html><body><button onclick="window.ran = (window.ran || 0) + 1">Go</button>'
        + '<a href="javascript:window.ran = 99">Link</a><img src="x" onerror="window.ran = 7"></body>',
    { url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1' });
    t.after(() => dom.window.close());
    const state = dom.window as unknown as { ran?: number };
    await trustedInput(dom.window.document.querySelector('button')!, { type: 'click' });
    await trustedInput(dom.window.document.querySelector('a')!, { type: 'click' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(state.ran, undefined);
    assert.equal(dom.window.document.querySelector('button')!.getAttribute('onclick'), 'window.ran = (window.ran || 0) + 1',
        'the attribute stays for product code to inspect');
    dom.window.eval('window.ran = 1');
    assert.equal(state.ran, 1, 'evaluated bundles still run');
});

test('runScripts: dangerously runs the fixture markup scripts', t => {
    const dom = new FixtureDom('<!doctype html><body><script>window.ran = 1;</script></body>', { runScripts: 'dangerously' });
    t.after(() => dom.window.close());
    assert.equal((dom.window as unknown as { ran?: number }).ran, 1);
});
