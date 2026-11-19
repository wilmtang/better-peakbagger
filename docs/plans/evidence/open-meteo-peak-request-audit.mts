/// <reference lib="dom" />
// Audit probe runs the built extension scripts in a hidden browser with offline fixtures.
// Run npm run build first, then node docs/plans/evidence/open-meteo-peak-request-audit.mts.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runDomTier, type DomCase, type DomContext } from '../../../scripts/dom-tier.mts';
import { waitForCondition, withOfflineFixturePage } from '../../../scripts/browser-verification-fixtures.mts';
import { settingsSchema } from '../../../src/settings/settings-schema.ts';
import { weatherFixture, weatherModelFixture } from '../../../test/helpers/weather-fixture.mjs';
import { cloudResponseForUrl } from '../../../test/helpers/summit-cloud-fixture.mjs';
import { airQualityFixture } from '../../../test/helpers/air-quality-fixture.mts';

if (process.argv.length !== 2) throw new Error('This audit probe takes no arguments.');
const bundlePaths = ['dist/content/peak-weather.js', 'dist/content/summit-cloud.js', 'dist/content/peak-cards.js'];
const bundles = await Promise.all(bundlePaths.map(file => readFile(file)));
const bundleSha256 = Object.fromEntries(bundlePaths.map((file, index) =>
    [file, createHash('sha256').update(bundles[index]!).digest('hex')]));
// Hash the source text embedded in the maps of the exact development bundles.
const sources = new Map<string, string>();
for (const bundle of bundlePaths) {
    const mapText = await readFile(`${bundle}.map`, 'utf8').catch(error => {
        throw new Error(`Cannot read the source map for ${bundle}. Run npm run build first.`, { cause: error });
    });
    const map = JSON.parse(mapText) as { sources?: unknown; sourcesContent?: unknown };
    assert.ok(Array.isArray(map.sources) && Array.isArray(map.sourcesContent)
        && map.sources.length > 0 && map.sources.length === map.sourcesContent.length, `Expected embedded sources for ${bundle}`);
    const contents: unknown[] = map.sourcesContent;
    map.sources.forEach((name: unknown, index) => {
        const content = contents[index];
        assert.ok(typeof name === 'string' && typeof content === 'string', `Invalid embedded source for ${bundle}`);
        const relative = name.replaceAll('\\', '/').replace(/^(?:\.\.\/)+/, '');
        assert.match(relative, /^(?:src|node_modules)\//, 'source maps must identify the bundled source');
        const previous = sources.get(relative);
        if (previous !== undefined) assert.equal(previous, content, relative);
        sources.set(relative, content);
    });
}
const inputs = [...sources.keys()].sort();
const sourceHash = createHash('sha256');
for (const input of inputs) sourceHash.update(input).update('\0').update(sources.get(input)!).update('\0');

const fixture = 'test/fixtures/pages/peak-rainier.html';
const html = await readFile(fixture, 'utf8');
const fixtureUrl = '/peak.aspx?pid=2296';
const auditStart = '2026-10-24T18:00:00Z';
interface AuditCall { kind: string; url: string; cache?: RequestCache }
interface AuditObserver { callback(entries: { isIntersecting: boolean }[]): void; target: Element | null }
type AuditWindow = typeof globalThis & {
    auditObservers: AuditObserver[];
    auditResponse(url: string, cache?: RequestCache): Promise<{ body: string; status?: number; headers: Record<string, string> }>;
};
type Preferences = Record<string, unknown>;
const results: Record<string, unknown>[] = [];
let inertFixture: string | undefined;

async function setup({ page, route, open }: DomContext, { limitedCloud = false } = {}) {
    let clock = Date.parse(auditStart);
    const calls: AuditCall[] = [];
    inertFixture ??= await withOfflineFixturePage(page.context(), preparation => preparation.evaluate(markup => {
        const doc = new DOMParser().parseFromString(markup, 'text/html');
        for (const script of doc.querySelectorAll('script')) script.remove();
        // Keep the native markup and block eager requests from fixture assets.
        const policy = doc.createElement('meta');
        policy.httpEquiv = 'Content-Security-Policy';
        policy.content = "default-src 'none'; script-src 'unsafe-inline'; script-src-attr 'none'; style-src 'unsafe-inline'";
        doc.head.prepend(policy);
        return '<!doctype html>' + doc.documentElement.outerHTML;
    }, html));
    await route('/peak.aspx', inertFixture);
    await page.clock.setFixedTime(new Date(clock));
    await page.exposeFunction('auditResponse', (input: string, cache?: RequestCache) => {
        const url = new URL(input), q = url.searchParams;
        const kind = url.pathname.startsWith('/data/') ? 'metadata' : url.hostname.startsWith('air-quality-api.') ? 'airQuality'
            : q.get('hourly')?.includes('hPa') ? 'cloud' : 'weather';
        calls.push({ kind, url: url.href, cache });
        if (kind === 'cloud' && limitedCloud) return { body: '', status: 429, headers: { 'retry-after': '60' } };
        let body;
        if (kind === 'metadata') body = { last_run_initialisation_time: clock / 1000 - 3600, last_run_availability_time: clock / 1000 - 600, update_interval_seconds: 21600 };
        else if (kind === 'cloud') body = cloudResponseForUrl(url.href);
        else if (kind === 'airQuality') body = airQualityFixture({ now: clock });
        else body = weatherModelFixture(weatherFixture({ startDate: q.get('start_date')!,
            hours: (Date.parse(q.get('end_date')!) - Date.parse(q.get('start_date')!)) / 3600000 + 24,
            latitude: Number(q.get('latitude')), longitude: Number(q.get('longitude')), elevation: Number(q.get('elevation')) }), q.get('models')!.split(','));
        return { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
    });
    await open(fixtureUrl);
    await page.evaluate(() => {
        const audit = window as unknown as AuditWindow;
        const observers: AuditObserver[] = [];
        audit.auditObservers = observers;
        window.IntersectionObserver = class {
            #observer: AuditObserver;
            constructor(callback: AuditObserver['callback']) {
                this.#observer = { callback, target: null };
                observers.push(this.#observer);
            }
            observe(target: Element) { this.#observer.target = target; }
            disconnect() { this.#observer.target = null; }
        } as unknown as typeof IntersectionObserver;
        window.scrollBy = () => {};
        window.fetch = async (input, init) => {
            const { body, status, headers } = await audit.auditResponse(String(input), init?.cache);
            return new Response(body, { status, headers });
        };
    });
    await page.evaluate(scripts => {
        for (const source of scripts) {
            const script = document.createElement('script');
            script.textContent = source;
            document.head.append(script);
            script.remove();
        }
    }, bundles.map(bundle => bundle.toString('utf8')));

    const settle = async () => {
        // Allow pending trigger tasks to start, then wait for the visible load state.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
        await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    };
    return {
        page, calls,
        async ready() {
            await page.waitForFunction(() => document.querySelectorAll('.bpb-peak-card-toggle').length === 2);
            await settle();
        },
        async enter(id?: string) {
            await page.evaluate(targetId => {
                for (const observer of (window as unknown as AuditWindow).auditObservers) {
                    if (observer.target && (!targetId || observer.target.id === targetId)) {
                        observer.callback([{ isIntersecting: true }]);
                    }
                }
            }, id);
            await settle();
        },
        async change(id: string, value: string) {
            await page.locator(`#${id}`).evaluate((node, selection) => {
                (node as HTMLSelectElement).value = selection;
                node.dispatchEvent(new Event('change'));
            }, value);
            await settle();
        },
        async click(selector: string) {
            await page.locator(selector).first().evaluate(node => (node as HTMLElement).click());
            await settle();
        },
        async details(selector: string) {
            await page.locator(selector).evaluate(node => { (node as HTMLDetailsElement).open = true; });
            await settle();
        },
        async advance(ms: number) {
            clock += ms;
            await page.clock.setFixedTime(new Date(clock));
        },
    };
}

type Audit = Awaited<ReturnType<typeof setup>>;
const waitForSourceMetadata = (env: Audit, start: number) => waitForCondition(async () => ({
    requests: env.calls.length - start,
    clocks: await env.page.locator('.bpb-week-source [data-update-model] [title^="Model initialized "]').count(),
}), {
    description: 'both GFS source metadata clocks',
    isReady: ({ requests, clocks }) => requests >= 2 && clocks === 2,
});
const summarize = (calls: AuditCall[]) => Object.fromEntries(['weather', 'cloud', 'metadata', 'airQuality', 'total'].map(kind => [kind, kind === 'total' ? calls.length : calls.filter(call => call.kind === kind).length]));
function record(name: string, env: Audit, expected: number[], start = 0) {
    const observed = summarize(env.calls.slice(start));
    assert.deepEqual(Object.values(observed), expected, name);
    results.push({ name, ...observed });
}
function scenario(preferences: Preferences, name: string, expected: number[], options?: { limitedCloud?: boolean }): DomCase {
    return {
        name,
        stub: { settings: settingsSchema.clean(preferences) },
        async run(context) {
            const env = await setup(context, options);
            await env.ready();
            await env.enter();
            record(name, env, expected);
            if (preferences.bpbPeakWeatherModelForecast) {
                assert.equal(new URL(env.calls.find(call => call.kind === 'weather')!.url).searchParams.get('models'), 'gfs_global,icon_global');
            }
            if (preferences.peakWeatherCollapsed) {
                assert.equal(await env.page.locator('#bpb-peak-weather').getAttribute('data-bpb-card-collapsed'), 'true');
            }
        },
    };
}

let defaultRequests: AuditCall[] = [];
const defaultCase: DomCase = {
    name: 'default interactions',
    stub: { settings: settingsSchema.clean({}) },
    async run(context) {
        const env = await setup(context);
        await env.ready(); record('Before either IntersectionObserver fires', env, [0, 0, 0, 0, 0]);
        await env.enter('bpb-peak-weather'); record('Only weather intersects', env, [1, 0, 0, 0, 1]);
        await env.enter('bpb-summit-cloud'); record('Default: both cards intersect', env, [1, 2, 2, 0, 5]);
        defaultRequests = [...env.calls];
        const weatherQuery = new URL(defaultRequests[0]!.url).searchParams;
        assert.equal(weatherQuery.get('hourly')!.split(',').length, 10);
        assert.equal((Date.parse(weatherQuery.get('end_date')!) - Date.parse(weatherQuery.get('start_date')!)) / 86400000 + 1, 32);
        for (const call of defaultRequests.filter(item => item.kind === 'cloud')) {
            const query = new URL(call.url).searchParams;
            assert.equal(query.get('latitude')!.split(',').length, 5);
            assert.equal(query.get('hourly')!.split(',').length, query.get('models') === 'gfs_hrrr' ? 84 : 72);
        }
        let start = env.calls.length;
        await env.click('#bpb-peak-weather-past'); await env.click('#bpb-peak-weather-forecast');
        await env.click('[aria-label="Show earlier hours"]'); await env.click('.bpb-cloud-hour');
        await env.details('.bpb-cloud-details');
        record('Period/hour/Why navigation: additional', env, [0, 0, 0, 0, 0], start);
        start = env.calls.length;
        await env.click('.bpb-week-refresh'); record('Weather Refresh with Source details closed: additional', env, [1, 0, 0, 0, 1], start);
        start = env.calls.length;
        await env.click('.bpb-cloud-refresh'); record('Cloud Refresh within cache TTL: additional', env, [0, 2, 0, 0, 2], start);
        start = env.calls.length;
        await env.change('bpb-summit-cloud-date', '2026-10-25'); record('Tomorrow, GFS replaces HRDPS: additional', env, [0, 2, 1, 0, 3], start);
        start = env.calls.length;
        await env.change('bpb-summit-cloud-date', '2026-10-24'); record('Return to cached day: additional', env, [0, 0, 0, 0, 0], start);
        start = env.calls.length;
        await env.details('.bpb-week-source');
        await waitForSourceMetadata(env, start);
        record('Open GFS Source details: additional', env, [0, 0, 2, 0, 2], start);
        start = env.calls.length;
        await env.click('.bpb-week-refresh');
        await waitForSourceMetadata(env, start);
        record('Weather Refresh with Source details open: additional', env, [1, 0, 2, 0, 3], start);
        start = env.calls.length;
        await env.click('#bpb-peak-weather-aqi'); record('First AQI selection: additional', env, [0, 0, 0, 1, 1], start);
        start = env.calls.length;
        await env.click('#bpb-peak-weather-forecast'); await env.click('#bpb-peak-weather-aqi');
        record('Reselect warm AQI: additional', env, [0, 0, 0, 0, 0], start);
        start = env.calls.length; await env.advance(300001);
        await env.click('.bpb-cloud-refresh'); record('Cloud Refresh after cache TTL: additional', env, [0, 2, 2, 0, 4], start);
    },
};

const cases = [
    defaultCase,
    scenario({ bpbSummitCloudModel: 'gfs_global' }, 'Manual GFS cloud', [1, 1, 1, 0, 3]),
    scenario({ showSummitCloud: false }, 'Cloud disabled', [1, 0, 0, 0, 1]),
    scenario({ showWeather: false, showSummitCloud: true }, 'Weather disabled, cloud explicitly enabled', [0, 2, 2, 0, 4]),
    scenario({ showWeather: false, showSummitCloud: false }, 'Both disabled', [0, 0, 0, 0, 0]),
    scenario({ peakCloudCollapsed: true }, 'Cloud saved collapsed', [1, 0, 0, 0, 1]),
    scenario({ peakWeatherCollapsed: true, peakCloudCollapsed: true }, 'Both saved collapsed', [0, 0, 0, 0, 0]),
    scenario({ bpbPeakWeatherModelForecast: 'icon_global' }, 'Distinct past/forecast surface models', [1, 2, 2, 0, 5]),
    scenario({}, 'Both cloud profile requests return 429', [1, 2, 0, 0, 3], { limitedCloud: true }),
    scenario({}, 'Fresh second page instance', [1, 2, 2, 0, 5]),
    {
        name: 'duplicate GFS metadata',
        stub: { settings: settingsSchema.clean({ bpbSummitCloudModel: 'gfs_global' }) },
        async run(context: DomContext) {
            const duplicate = await setup(context);
            await duplicate.ready();
            await duplicate.enter();
            const start = duplicate.calls.length;
            await duplicate.details('.bpb-week-source');
            await waitForSourceMetadata(duplicate, start);
            record('Manual GFS: opening Source repeats cloud GFS025 metadata', duplicate, [0, 0, 2, 0, 2], start);
            assert.equal(duplicate.calls.filter(call => call.url.endsWith('/data/ncep_gfs025/static/meta.json')).length, 2);
        },
    },
];
let chromiumVersion: string | undefined;
await runDomTier(['chrome'], [{ name: 'Open-Meteo request audit', cases }], report => {
    if (report.engine === 'chrome' && typeof report.version === 'string') chromiumVersion = report.version;
});
assert.ok(chromiumVersion);
assert(results.length > 0);
console.log(JSON.stringify({ auditedHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceInputsSha256: sourceHash.digest('hex'), sourceInputs: inputs, bundleSha256, clock: auditStart, fixture,
    method: `Built dist IIFEs in hidden Chromium ${chromiumVersion} at 1000 × 760, with stubbed settings, intersection, clock and HTTP responses. No live network.`,
    assertions: results.length, results, defaultRequests }, null, 2));
