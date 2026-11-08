import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// @ts-expect-error jsdom ships no declarations in this repository.
import { JSDOM } from 'jsdom';
import { settingsSchema } from '../../src/settings/settings-schema.ts';
import { cloudResponseForUrl } from '../helpers/summit-cloud-fixture.mjs';

const [html, bundle, layout] = await Promise.all([
    readFile(new URL('../fixtures/pages/peak-rainier.html', import.meta.url), 'utf8'),
    readFile(new URL('../../dist/content/summit-cloud.js', import.meta.url), 'utf8'),
    readFile(new URL('../../dist/content/peak-cards.js', import.meta.url), 'utf8'),
]);
const wait = async (predicate: () => unknown) => {
    const end = Date.now() + 2500;
    while (!predicate()) { if (Date.now() > end) throw new Error('Summit cloud UI did not settle'); await new Promise(resolve => setTimeout(resolve, 0)); }
};
function setup({ preferences = {}, now = '2026-10-24T18:00Z', lazy = false, manualClock = false } = {}) {
    const jsdom = new JSDOM(html, { url: 'https://www.peakbagger.com/peak.aspx?pid=2296', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = jsdom.window;
    const requests: { url: string; options: RequestInit & { signal: AbortSignal }; mode: string }[] = [], writes: Record<string, unknown>[] = [];
    const listeners = new Set<(changes: unknown, area: string) => void>(), observers: { fn: (entries: { isIntersecting: boolean }[]) => void }[] = [], held: (() => void)[] = [];
    let stored = settingsSchema.clean(preferences), mode = 'complete';
    win.Date.now = () => Date.parse(now); win.AbortController = AbortController; win.TextDecoder = TextDecoder;
    const minuteJobs = new Map<unknown, () => void>(), setTimer = win.setTimeout.bind(win), clearTimer = win.clearTimeout.bind(win);
    if (manualClock) {
        win.setTimeout = (callback: () => void, delay: number, ...args: unknown[]) => {
            const id = setTimer(callback, delay, ...args);
            if (delay === 60000 - win.Date.now() % 60000) minuteJobs.set(id, callback);
            return id;
        };
        win.clearTimeout = (id: unknown) => { minuteJobs.delete(id); clearTimer(id); };
    }
    win.chrome = { storage: { sync: { get: async () => ({ bpbSettings: stored }) }, local: { get: async () => ({}) }, onChanged: {
        addListener: (fn: (changes: unknown, area: string) => void) => listeners.add(fn), removeListener: (fn: (changes: unknown, area: string) => void) => listeners.delete(fn),
    } }, runtime: { sendMessage: async (message: { patch: Record<string, unknown> }) => { writes.push(message.patch); update(message.patch); return { ok: true, settings: stored }; } } };
    const update = (patch: Record<string, unknown>) => { const oldValue = stored; stored = settingsSchema.clean({ ...stored, ...patch }); listeners.forEach(fn => fn({ bpbSettings: { oldValue, newValue: stored } }, 'sync')); };
    if (lazy) win.IntersectionObserver = class { fn; constructor(fn: (entries: { isIntersecting: boolean }[]) => void) { this.fn = fn; observers.push(this); } observe() {} disconnect() {} };
    win.fetch = async (url: string, options: RequestInit & { signal: AbortSignal }) => {
        if (new URL(url).pathname.startsWith('/data/')) return new Response(JSON.stringify({ last_run_initialisation_time: Date.parse(now) / 1000 - 3600, last_run_availability_time: Date.parse(now) / 1000 - 600, update_interval_seconds: 21600 }), { headers: { 'content-type': 'application/json' } });
        const request = { url, options, mode }; requests.push(request);
        if (mode === 'hold') await new Promise<void>(resolve => held.push(resolve));
        if (request.mode === 'error') return new Response('', { status: 503 });
        if (request.mode === 'fail-hrdps' && new URL(url).searchParams.get('models') === 'gem_hrdps_continental') return new Response('', { status: 503 });
        if (request.mode === 'limited') return new Response('', { status: 429, headers: { 'retry-after': '60' } });
        return new Response(JSON.stringify(cloudResponseForUrl(url, request.mode === 'cloudy' ? { cloud: 95, humidity: 98 } : undefined)), { headers: { 'content-type': 'application/json' } });
    };
    win.eval(bundle); win.eval(layout);
    const doc = win.document, card = () => doc.querySelector('#bpb-summit-cloud');
    return { win, doc, requests, writes, observers, update, card, get stored() { return stored; },
        minuteJobs, tick(value: string) { const [id, callback] = minuteJobs.entries().next().value as [unknown, () => void]; win.clearTimeout(id); win.Date.now = () => Date.parse(value); callback(); },
        mode: (value: string) => { mode = value; }, release: () => held.splice(0).forEach(resolve => resolve()),
        choose: (id: string, value: string) => { const node = doc.getElementById(`bpb-summit-cloud-${id}`); node.value = value; node.dispatchEvent(new win.Event('change')); },
        close: () => { held.splice(0).forEach(resolve => resolve()); win.dispatchEvent(new win.PageTransitionEvent('pagehide')); win.close(); } };
}
const settled = (env: ReturnType<typeof setup>) => wait(() => env.requests.length > 0 && env.card()?.getAttribute('aria-busy') === 'false' && env.doc.querySelector('.bpb-cloud-status')?.textContent === 'Cloud profiles updated.');
test('selected cloud hours identify the summit-local date and their relation to now', async () => {
    // UTC is already Sunday; the summit is still on Saturday evening.
    const env = setup({ now: '2026-10-25T06:30Z', preferences: { bpbSummitCloudModel: 'gfs_global' } });
    try {
        await settled(env);
        assert.match(env.doc.querySelector('.bpb-cloud-selected-clock').textContent, /Today.*Sat, Oct 24.*11:00 PM PDT.*Current hour/);
        assert.match(env.doc.querySelector('#bpb-summit-cloud-date option:nth-child(2)').textContent, /Tomorrow.*Sun, Oct 25/);
        const count = env.requests.length;
        env.doc.querySelector('.bpb-cloud-hour').click();
        assert.match(env.doc.querySelector('.bpb-cloud-selected-clock').textContent, /Today.*Sat, Oct 24.*12:00 AM PDT.*Past forecast/);
        assert.equal(env.requests.length, count, 'exploring the timeline does not fetch more data');
        env.choose('date', '2026-10-25'); await settled(env);
        assert.match(env.doc.querySelector('.bpb-cloud-selected-clock').textContent, /Tomorrow.*Sun, Oct 25.*12:00 AM PDT.*Future forecast/);
    } finally { env.close(); }
});
test('keyboard exploration keeps UTC selection and focus through refresh without fetching on navigation', async () => {
    const env = setup({ preferences: { bpbSummitCloudModel: 'gfs_global' } });
    try {
        await settled(env);
        const count = env.requests.length, nodes = [...env.doc.querySelectorAll('.bpb-cloud-hour')];
        const selected = () => env.doc.querySelector('.bpb-cloud-hour[aria-pressed="true"]');
        selected().focus();
        for (const [key, index] of [['End', 23], ['Home', 0], ['ArrowRight', 1], ['ArrowLeft', 0]] as [string, number][]) {
            selected().dispatchEvent(new env.win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
            assert.equal(selected(), nodes[index]); assert.equal(env.doc.activeElement, selected());
            assert.equal(env.doc.querySelectorAll('.bpb-cloud-hour[tabindex="0"]').length, 1);
        }
        assert.equal(env.requests.length, count);
        env.mode('hold'); env.doc.querySelector('.bpb-cloud-refresh').click();
        await wait(() => env.card().getAttribute('aria-busy') === 'true');
        assert.equal(env.doc.activeElement, nodes[0]);
        env.release(); await settled(env);
        assert.equal(selected(), nodes[0]); assert.equal(env.doc.activeElement, nodes[0]);
        assert.equal(env.doc.querySelector('.bpb-cloud-selected-clock').getAttribute('datetime'), new Date(Number(nodes[0].dataset.time)).toISOString());
    } finally { env.close(); }
});
test('a failed date switch keeps the retained forecast date explicit', async () => {
    const env = setup({ preferences: { bpbSummitCloudModel: 'gfs_global' } });
    try {
        await settled(env); env.mode('error'); env.choose('date', '2026-10-25');
        await wait(() => env.doc.querySelector('.bpb-cloud-status').textContent.includes('Refresh failed'));
        assert.equal(env.doc.querySelector('#bpb-summit-cloud-date').value, '2026-10-25');
        assert.match(env.doc.querySelector('.bpb-cloud-day').textContent, /Today.*Oct 24/);
        assert.match(env.doc.querySelector('.bpb-cloud-selected-clock').textContent, /Today.*Oct 24/);
        env.mode('complete'); env.doc.querySelector('.bpb-cloud-refresh').click(); await settled(env);
        assert.match(env.doc.querySelector('.bpb-cloud-day').textContent, /Tomorrow.*Oct 25/);
    } finally { env.close(); }
});
test('the local clock advances across midnight without fetching and stops when the card is disabled', async () => {
    const env = setup({ now: '2026-10-25T06:59Z', manualClock: true, preferences: { bpbSummitCloudModel: 'gfs_global' } });
    try {
        await settled(env);
        assert.equal(env.minuteJobs.size, 1);
        assert.equal(env.doc.querySelectorAll('.bpb-cloud-hour[data-temporal="now"]').length, 1);
        const count = env.requests.length;
        env.tick('2026-10-25T07:00Z');
        assert.match(env.doc.querySelector('.bpb-cloud-day').textContent, /Yesterday.*Sat, Oct 24/);
        assert.match(env.doc.querySelector('.bpb-cloud-selected-clock').textContent, /Yesterday.*Past forecast/);
        assert.equal(env.doc.querySelectorAll('.bpb-cloud-hour[data-temporal="now"]').length, 0);
        assert.equal(env.requests.length, count);
        env.update({ showSummitCloud: false });
        await wait(() => env.card().hidden);
        assert.equal(env.minuteJobs.size, 0);
    } finally { env.close(); }
});
test('card shares layout ownership, uses saved model, exposes all hours and remembers changes', async () => {
    const env = setup({ preferences: { bpbSummitCloudModel: 'gfs_global' } });
    try {
        await settled(env);
        assert.equal(env.card().dataset.bpbPeakCard, 'cloud');
        assert.equal(env.doc.querySelectorAll('#bpb-summit-cloud .bpb-peak-card-toggle').length, 1);
        assert.equal(env.card().closest('tr').id, 'bpb-summit-cloud-row');
        assert.equal(env.doc.querySelectorAll('.bpb-cloud-hour').length, 24);
        assert.equal(new URL(env.requests[0].url).searchParams.get('models'), 'gfs_global');
        assert.equal(env.doc.querySelectorAll('#bpb-summit-cloud-date option').length, 16);
        assert.equal(env.doc.querySelector('#bpb-summit-cloud-model').getAttribute('form'), '');
        assert.equal(new Set([...env.doc.querySelectorAll('.bpb-cloud-hour')].map(button => button.dataset.time)).size, 24);
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
        await wait(() => env.observers.length > 0); env.mode('hold'); env.observers.at(-1)!.fn([{ isIntersecting: true }]);
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
test('a failed comparison request names only the forecast shown and keeps its estimate', async () => {
    const env = setup();
    try {
        env.mode('fail-hrdps');
        await wait(() => env.doc.querySelector('.bpb-cloud-status')?.textContent === 'One forecast could not be loaded.');
        const source = env.doc.querySelector('.bpb-cloud-source')!.textContent!;
        assert.match(source, /Showing: HRRR/); assert.doesNotMatch(source, /HRDPS/);
        assert.match(env.doc.querySelector('.bpb-cloud-reason')!.textContent!, /^Only HRRR could be evaluated/);
        assert.equal(env.doc.querySelector('.bpb-cloud-confidence')!.textContent, 'Low confidence');
        assert.equal(env.doc.querySelector('.bpb-cloud-prediction')!.textContent, 'Summit likely clear of cloud');
    } finally { env.close(); }
});
test('DST days keep distinct hourly identities and BFCache suspension aborts without duplicating the card', async () => {
    for (const [now, expected] of [['2026-11-01T15:00Z', 25], ['2026-03-08T15:00Z', 23]] as [string, number][]) {
        const env = setup({ now, preferences: { bpbSummitCloudModel: 'gfs_global' } });
        try {
            await settled(env); assert.equal(env.doc.querySelectorAll('.bpb-cloud-hour').length, expected);
            assert.match(env.doc.querySelector('.bpb-cloud-hours').getAttribute('aria-label'), new RegExp(`${expected} hours`));
            const nodes = [...env.doc.querySelectorAll('.bpb-cloud-hour')];
            assert.equal(new Set(nodes.map(node => node.dataset.time)).size, expected);
            if (expected === 25) {
                const repeated = nodes.filter(node => node.querySelector('.bpb-cloud-clock').textContent === '1 AM');
                assert.equal(repeated.length, 2);
                assert.deepEqual(repeated.map(node => node.querySelector('.bpb-cloud-hour-zone').textContent), ['PDT', 'PST']);
            }
            env.mode('hold'); env.doc.querySelector('.bpb-cloud-refresh').click(); await wait(() => env.card().getAttribute('aria-busy') === 'true');
            env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
            assert.equal(env.requests.at(-1)!.options.signal.aborted, true); env.release();
            env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
            assert.equal(env.doc.querySelectorAll('#bpb-summit-cloud').length, 1);
        } finally { env.close(); }
    }
});
