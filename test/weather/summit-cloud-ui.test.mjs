import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { settingsSchema } from '../../src/settings/settings-schema.js';
import { cloudResponseForUrl } from '../helpers/summit-cloud-fixture.mjs';

const [html, bundle, layout] = await Promise.all([
    readFile(new URL('../fixtures/pages/peak-rainier.html', import.meta.url), 'utf8'),
    readFile(new URL('../../dist/content/summit-cloud.js', import.meta.url), 'utf8'),
    readFile(new URL('../../dist/content/peak-cards.js', import.meta.url), 'utf8'),
]);
const wait = async predicate => {
    const end = Date.now() + 2500;
    while (!predicate()) { if (Date.now() > end) throw new Error('Summit cloud UI did not settle'); await new Promise(resolve => setTimeout(resolve, 0)); }
};
function setup({ preferences = {}, now = '2026-10-24T18:00Z', lazy = false } = {}) {
    const jsdom = new JSDOM(html, { url: 'https://www.peakbagger.com/peak.aspx?pid=2296', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = jsdom.window, requests = [], writes = [], listeners = new Set(), observers = [], held = [];
    let stored = settingsSchema.clean(preferences), mode = 'complete';
    win.Date.now = () => Date.parse(now); win.AbortController = AbortController; win.TextDecoder = TextDecoder;
    win.chrome = { storage: { sync: { get: async () => ({ bpbSettings: stored }) }, local: { get: async () => ({}) }, onChanged: {
        addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    } }, runtime: { sendMessage: async message => { writes.push(message.patch); update(message.patch); return { ok: true, settings: stored }; } } };
    const update = patch => { const oldValue = stored; stored = settingsSchema.clean({ ...stored, ...patch }); listeners.forEach(fn => fn({ bpbSettings: { oldValue, newValue: stored } }, 'sync')); };
    if (lazy) win.IntersectionObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() {} };
    win.fetch = async (url, options) => {
        if (new URL(url).pathname.startsWith('/data/')) return new Response(JSON.stringify({ last_run_initialisation_time: Date.parse(now) / 1000 - 3600, last_run_availability_time: Date.parse(now) / 1000 - 600, update_interval_seconds: 21600 }), { headers: { 'content-type': 'application/json' } });
        const request = { url, options, mode }; requests.push(request);
        if (mode === 'hold') await new Promise(resolve => held.push(resolve));
        if (request.mode === 'error') return new Response('', { status: 503 });
        if (request.mode === 'limited') return new Response('', { status: 429, headers: { 'retry-after': '60' } });
        return new Response(JSON.stringify(cloudResponseForUrl(url, request.mode === 'cloudy' ? { cloud: 95, humidity: 98 } : undefined)), { headers: { 'content-type': 'application/json' } });
    };
    win.eval(bundle); win.eval(layout);
    const doc = win.document, card = () => doc.querySelector('#bpb-summit-cloud');
    return { win, doc, requests, writes, observers, update, card, get stored() { return stored; },
        mode: value => { mode = value; }, release: () => held.splice(0).forEach(resolve => resolve()),
        choose: (id, value) => { const node = doc.getElementById(`bpb-summit-cloud-${id}`); node.value = value; node.dispatchEvent(new win.Event('change')); },
        close: () => { held.splice(0).forEach(resolve => resolve()); win.dispatchEvent(new win.PageTransitionEvent('pagehide')); win.close(); } };
}
const settled = env => wait(() => env.requests.length > 0 && env.card()?.getAttribute('aria-busy') === 'false' && env.doc.querySelector('.bpb-cloud-status')?.textContent === 'Cloud profiles updated.');
test('card shares layout ownership, uses saved model, exposes all hours and remembers changes', async () => {
    const env = setup({ preferences: { bpbSummitCloudModel: 'gfs_global' } });
    try {
        await settled(env);
        assert.equal(env.card().dataset.bpbPeakCard, 'cloud');
        assert.equal(env.doc.querySelectorAll('#bpb-summit-cloud .bpb-peak-card-toggle').length, 1);
        assert.equal(env.card().closest('tr').id, 'bpb-summit-cloud-row');
        assert.equal(env.doc.querySelectorAll('.bpb-cloud-hour').length, 8);
        assert.equal(new URL(env.requests[0].url).searchParams.get('models'), 'gfs_global');
        assert.equal(env.doc.querySelectorAll('#bpb-summit-cloud-date option').length, 16);
        assert.equal(env.doc.querySelector('#bpb-summit-cloud-model').getAttribute('form'), '');
        const seen = new Set();
        while (env.doc.querySelector('[aria-label="Show earlier hours"]').getAttribute('aria-disabled') !== 'true') env.doc.querySelector('[aria-label="Show earlier hours"]').click();
        for (;;) {
            env.doc.querySelectorAll('.bpb-cloud-hour').forEach(button => seen.add(button.dataset.index));
            const later = env.doc.querySelector('[aria-label="Show later hours"]'); if (later.getAttribute('aria-disabled') === 'true') break; later.click();
        }
        assert.equal(seen.size, 24);
        env.choose('model', 'icon_global'); await settled(env);
        await wait(() => env.stored.bpbSummitCloudModel === 'icon_global');
        assert.ok(env.writes.some(patch => patch.bpbSummitCloudModel === 'icon_global'));
        assert.match(env.doc.querySelector('.bpb-cloud-source').textContent, /ICON/);
        assert.match(env.doc.querySelector('.bpb-cloud-evidence').textContent, /humidity/);
    } finally { env.close(); }
});
test('disabled and saved collapsed cards do not fetch; lazy opening and collapse cancel work', async () => {
    const disabled = setup({ preferences: { showSummitCloud: false } });
    const env = setup({ preferences: { peakCloudCollapsed: true }, lazy: true });
    try {
        await wait(() => env.card()?.dataset.bpbCardCollapsed === 'true');
        assert.equal(disabled.requests.length, 0); assert.equal(env.requests.length, 0);
        env.doc.querySelector('#bpb-summit-cloud .bpb-peak-card-toggle').click();
        await wait(() => env.observers.length > 0); env.mode('hold'); env.observers.at(-1).fn([{ isIntersecting: true }]);
        await wait(() => env.requests.length === 2);
        env.doc.querySelector('#bpb-summit-cloud .bpb-peak-card-toggle').click();
        await wait(() => env.requests.every(request => request.options.signal.aborted));
        env.release(); assert.equal(env.card().getAttribute('aria-busy'), 'false');
    } finally { env.close(); disabled.close(); }
});
test('failed switches retain source identity, stale completions cannot replace new intent, and cooldown guards actions', async () => {
    const env = setup({ preferences: { bpbSummitCloudModel: 'gfs_global' } });
    try {
        await settled(env); env.mode('hold'); env.choose('model', 'icon_global'); await wait(() => env.requests.length === 2);
        env.mode('cloudy'); env.choose('model', 'gem_global'); await settled(env); env.release();
        assert.match(env.doc.querySelector('.bpb-cloud-source').textContent, /GEM/);
        assert.match(env.doc.querySelector('.bpb-cloud-prediction').textContent, /inside cloud/);
        env.mode('error'); env.choose('model', 'gfs_hrrr'); await wait(() => env.doc.querySelector('.bpb-cloud-status').textContent.includes('Refresh failed'));
        assert.match(env.doc.querySelector('.bpb-cloud-source').textContent, /GEM/);
        env.mode('limited'); env.doc.querySelector('.bpb-cloud-refresh').click(); await wait(() => env.doc.querySelector('.bpb-cloud-status').textContent.includes('limited'));
        const count = env.requests.length; env.doc.querySelector('.bpb-cloud-refresh').click(); env.choose('model', 'auto');
        assert.equal(env.requests.length, count); assert.equal(env.doc.querySelector('#bpb-summit-cloud-model').value, 'gfs_hrrr');
    } finally { env.close(); }
});
test('DST days keep distinct hourly identities and BFCache suspension aborts without duplicating the card', async () => {
    for (const [now, expected] of [['2026-11-01T15:00Z', 25], ['2026-03-08T15:00Z', 23]]) {
        const env = setup({ now, preferences: { bpbSummitCloudModel: 'gfs_global' } });
        try {
            await settled(env); assert.match(env.doc.querySelector('.bpb-cloud-range').textContent, new RegExp(`${expected} hours`));
            env.mode('hold'); env.doc.querySelector('.bpb-cloud-refresh').click(); await wait(() => env.card().getAttribute('aria-busy') === 'true');
            env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
            assert.equal(env.requests.at(-1).options.signal.aborted, true); env.release();
            env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
            assert.equal(env.doc.querySelectorAll('#bpb-summit-cloud').length, 1);
        } finally { env.close(); }
    }
});
