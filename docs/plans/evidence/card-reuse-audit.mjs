// Read-only regression check; --expect-regression is for the original bundle.
// Run npm run build, then node docs/plans/evidence/card-reuse-audit.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { weatherFixture } from '../../../test/helpers/weather-fixture.mjs';

const expectRegression = process.argv.length === 3 && process.argv[2] === '--expect-regression';
if (process.argv.length !== (expectRegression ? 3 : 2)) throw new Error('Usage: node docs/plans/evidence/card-reuse-audit.mjs [--expect-regression]');
const [ascent, peak, layout, bundle] = await Promise.all([
    readFile('test/fixtures/pages/climber-ascent.html', 'utf8'), readFile('test/fixtures/pages/peak-rainier.html', 'utf8'),
    readFile('dist/content/ascent-layout.js', 'utf8'), readFile('dist/content/ascent-weather.js', 'utf8'),
]);
const dom = new JSDOM(ascent.replaceAll('Sunday, July 12, 2026', 'Friday, July 12, 2024'), {
    url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321', runScripts: 'outside-only', pretendToBeVisual: true,
});
const win = dom.window, doc = win.document;
Object.assign(win, { AbortController, TextDecoder, TextEncoder });
win.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 620, height: 200, top: 0, left: 0, right: 620, bottom: 200 });
win.SVGElement.prototype.getBoundingClientRect = win.HTMLElement.prototype.getBoundingClientRect;
win.chrome = { storage: { local: { get: async () => ({}) }, sync: { get: async () => ({ bpbSettings: { units: 'metric', showWeather: true } }) },
    onChanged: { addListener() {}, removeListener() {} } } };
win.fetch = async url => {
    if (new URL(url).hostname === 'www.peakbagger.com') return new Response(peak, { headers: { 'content-type': 'text/html' } });
    const body = weatherFixture();
    body.hourly.wind_speed_10m.fill(0); body.hourly.wind_gusts_10m.fill(0);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
};
const wait = async condition => {
    const deadline = Date.now() + 3000;
    while (!condition()) { if (Date.now() > deadline) throw new Error('Archive weather did not settle'); await new Promise(resolve => setTimeout(resolve, 0)); }
};
try {
    win.eval(layout); win.eval(bundle);
    await wait(() => doc.querySelector('.bpb-weather-metrics dd') && doc.querySelector('.bpb-weather-metrics dd').textContent !== '—'
        && doc.querySelector('#bpb-ascent-weather')?.getAttribute('aria-busy') === 'false');
    doc.querySelector('.bpb-weather-disclosure').click();
    doc.querySelector('[data-metric="wind"]').click();
    const chart = doc.querySelector('.bpb-weather-chart');
    const labels = [...chart.querySelectorAll('text[text-anchor="end"]')].map(node => node.textContent).filter(value => /^\d+$/.test(value));
    assert.equal(labels.length, 3);
    if (expectRegression) assert.deepEqual(labels, ['0', '1', '1']);
    else assert.equal(new Set(labels).size, 3, `Axis labels must be distinct: ${labels}`);
    console.log(JSON.stringify({ auditedHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        ascentSourceSha256: createHash('sha256').update(await readFile('src/ascent/ascent-weather.js')).digest('hex'),
        peakChartSourceSha256: createHash('sha256').update(await readFile('src/weather/peak-weather-hourly.js')).digest('hex'),
        ascentBundleSha256: createHash('sha256').update(bundle).digest('hex'), inputWindKmh: 0, displayedUnit: 'km/h', axisLabels: labels,
        method: 'Built dist bundle in jsdom, stubbed transport/settings and 620px chart bounds; no real browser or live network',
    }, null, 2));
} finally { win.dispatchEvent(new win.PageTransitionEvent('pagehide')); win.close(); }
