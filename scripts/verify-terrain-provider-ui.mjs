// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, getComputedStyle, requestAnimationFrame */

import assert from 'node:assert/strict';

const configureCredits = ({ width, theme, largeText, long }) => {
    const mount = document.getElementById('bpb-map-viewport');
    const frame = document.getElementById('bpb-terrain-frame');
    const doc = frame.contentDocument;
    const map = frame.contentWindow.__bpbTerrainTestMap;
    const surface = doc.getElementById('bpb-terrain-map');
    const source = map.getSource('basemap');
    window.__bpbCreditsProbe ??= {
        mountStyle: mount.getAttribute('style'), theme: surface.dataset.theme,
        attribution: source.attribution,
        hintClass: doc.querySelector('.bpb-terrain-hint').className,
        hintHidden: doc.querySelector('.bpb-terrain-hint').hidden,
    };
    const hint = doc.querySelector('.bpb-terrain-hint');
    hint.hidden = false; hint.classList.remove('bpb-terrain-hint-dismissed');
    mount.style.width = `${width}px`;
    surface.dataset.theme = theme;
    let textStyle = doc.getElementById('bpb-credits-text-probe');
    if (!textStyle) {
        textStyle = doc.createElement('style'); textStyle.id = 'bpb-credits-text-probe'; doc.head.append(textStyle);
    }
    textStyle.textContent = largeText ? '#bpb-terrain-map, #bpb-terrain-map .maplibregl-ctrl-attrib { font-size: 24px; }' : '';
    source.attribution = long
        ? '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> | <a href="https://openmaptiles.org/">OpenMapTiles</a> | Regional mapping contributors and elevation data providers'
        : '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
    map.fire('sourcedata', { dataType: 'source', sourceDataType: 'metadata' });
    map.resize();
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};

const readCredits = () => {
    const frame = document.getElementById('bpb-terrain-frame');
    const doc = frame.contentDocument;
    const box = element => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const credits = doc.querySelector('.maplibregl-ctrl-attrib-inner');
    const style = getComputedStyle(credits);
    const link = credits.querySelector('a[href="https://www.openstreetmap.org/copyright"]');
    const hint = doc.querySelector('.bpb-terrain-hint');
    return {
        visible: style.display !== 'none' && style.visibility !== 'hidden' && credits.getClientRects().length > 0,
        linkVisible: Boolean(link?.getClientRects().length), credits: box(credits),
        creditText: credits.textContent, frameWidth: doc.documentElement.clientWidth,
        hint: box(hint), hintVisible: !hint.hidden && getComputedStyle(hint).opacity !== '0',
        nav: box(doc.querySelector('.maplibregl-ctrl-group')),
        scale: box(doc.querySelector('.maplibregl-ctrl-scale')),
        picker: box(doc.querySelector('.bpb-terrain-picker')),
        toggle: box(document.getElementById('bpb-terrain-toggle')),
        heading: box(document.querySelector('.terrain-check h2')),
        following: box(document.querySelector('.analyzer-shell')),
        mount: box(document.getElementById('bpb-map-viewport')),
        scroll: { x: window.scrollX, y: window.scrollY },
    };
};

const restoreCredits = () => {
    const saved = window.__bpbCreditsProbe;
    const mount = document.getElementById('bpb-map-viewport');
    const frame = document.getElementById('bpb-terrain-frame');
    const map = frame.contentWindow.__bpbTerrainTestMap;
    if (saved.mountStyle === null) mount.removeAttribute('style'); else mount.setAttribute('style', saved.mountStyle);
    frame.contentDocument.getElementById('bpb-terrain-map').dataset.theme = saved.theme;
    frame.contentDocument.getElementById('bpb-credits-text-probe')?.remove();
    const hint = frame.contentDocument.querySelector('.bpb-terrain-hint');
    hint.className = saved.hintClass; hint.hidden = saved.hintHidden;
    map.getSource('basemap').attribution = saved.attribution;
    map.fire('sourcedata', { dataType: 'source', sourceDataType: 'metadata' }); map.resize();
    delete window.__bpbCreditsProbe;
};

export const assertStableTerrainGeometry = (before, after, label, keys = ['nav', 'scale', 'picker', 'toggle', 'heading', 'following', 'mount', 'scroll']) => {
    for (const key of keys) for (const field of Object.keys(before[key])) {
        assert.ok(Math.abs(before[key][field] - after[key][field]) <= 1,
            `${label}: ${key}.${field} moved (${before[key][field]} → ${after[key][field]})`);
    }
};

// Uses the actual MapLibre control and source attribution. Only provider data
// is synthetic; font enlargement exercises wrapping without hiding overflow.
export async function verifyTerrainCredits({ evaluate, screenshot }) {
    let cases = 0;
    try {
        for (const width of [800, 320]) for (const theme of ['light', 'dark']) for (const largeText of [false, true]) {
            const label = `${width}-${theme}-${largeText ? 'large-text' : 'normal'}`;
            await evaluate(`(${configureCredits})(${JSON.stringify({ width, theme, largeText, long: false })})`);
            const before = await evaluate(`(${readCredits})()`);
            assert.ok(before.visible && before.linkVisible, `${label}: OSM credits must be visible without opening a toggle`);
            if (screenshot && !largeText) await screenshot(`terrain-credits-short-${label}`);
            await evaluate(`(${configureCredits})(${JSON.stringify({ width, theme, largeText, long: true })})`);
            const after = await evaluate(`(${readCredits})()`);
            assert.ok(after.visible && after.linkVisible, `${label}: expanded credits remain visible`);
            assert.match(after.creditText, /Regional mapping contributors/, `${label}: long provider attribution was applied`);
            assert.ok(after.credits.y >= 0, `${label}: credits must stay inside the map`);
            assert.ok(after.credits.x >= 0 && after.credits.right <= after.frameWidth - 60,
                `${label}: credits must wrap clear of the zoom controls: ${JSON.stringify(after)}`);
            if (after.hintVisible) {
                assert.ok(after.hint.y >= 0, `${label}: gesture hint must stay inside the map`);
                assert.ok(after.hint.bottom <= after.credits.y, `${label}: gesture hint covers credits`);
            }
            assertStableTerrainGeometry(before, after, label);
            if (screenshot) await screenshot(`terrain-credits-${label}`);
            cases++;
        }
    } finally { await evaluate(`(${restoreCredits})()`); }
    assert.equal(cases, 8, 'all terrain credit cases must execute');
    console.log(`  - ${cases} terrain credit layouts: visible links, wrapping and stable controls`);
}

const selectRaster = ({ fresh = false } = {}) => {
    const frame = document.getElementById('bpb-terrain-frame');
    const picker = frame.contentDocument.querySelector('.bpb-terrain-picker');
    const map = frame.contentWindow.__bpbTerrainTestMap;
    // Fixture-only instrumentation preserves the production transform while
    // varying local tile URLs; it must not introduce a cache-bypass mode.
    window.__bpbProviderTransform ??= map._requestManager._transformRequestFn;
    const original = window.__bpbProviderTransform;
    const revision = ++window.__bpbProviderProbeRevision;
    map.setTransformRequest(fresh ? (url, type) => {
        const request = original?.(url, type) || { url };
        return type === 'Tile' && request.url.includes('/scripts/showcase/terrain-tiles/')
            ? { ...request, url: `${request.url}?providerProbe=${revision}` } : request;
    } : original);
    picker.focus({ preventScroll: true });
    picker.value = '0'; picker.dispatchEvent(new frame.contentWindow.Event('change'));
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};

const readRecovery = () => {
    const frame = document.getElementById('bpb-terrain-frame');
    const doc = frame.contentDocument, map = frame.contentWindow.__bpbTerrainTestMap;
    const picker = doc.querySelector('.bpb-terrain-picker'), notice = doc.querySelector('.bpb-terrain-notice');
    const controls = doc.querySelector('.bpb-terrain-controls'), nr = notice.getBoundingClientRect();
    const fr = frame.getBoundingClientRect();
    const intersects = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    const globalNotice = { left: nr.left + fr.left, right: nr.right + fr.left, top: nr.top + fr.top, bottom: nr.bottom + fr.top };
    const coversAction = ['bpb-terrain-toggle', 'bpb-terrain-compass'].some(id => {
        const element = document.getElementById(id);
        return element && !element.hidden && intersects(globalNotice, element.getBoundingClientRect());
    }) || intersects(nr, doc.querySelector('.maplibregl-ctrl-group').getBoundingClientRect());
    return { selected: picker.value, retryable: !picker.options[0].disabled,
        notice: notice.textContent, noticeHidden: notice.hidden,
        noticeKind: notice.dataset.kind,
        feedbackFits: notice.hidden || (nr.left >= 0 && nr.right <= doc.documentElement.clientWidth && nr.bottom <= doc.documentElement.clientHeight && !coversAction),
        horizontalOverflow: getComputedStyle(controls).overflowX === 'visible' ? 0 : controls.scrollWidth - controls.clientWidth,
        focus: doc.activeElement === picker, painted: Boolean(map.getSource('basemap') && map.isSourceLoaded('basemap')),
        route: Boolean(map.getLayer('bpb-route')), frameVisible: frame.style.opacity === '1' };
};

const until = async (read, predicate, label) => {
    const deadline = Date.now() + 20_000;
    let value;
    do {
        value = await read();
        if (predicate(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error(`${label}: ${JSON.stringify(value)}`);
};

export async function verifyTerrainProviderRecovery({ evaluate, blockRaster, releaseRaster, retryWithKeyboard, screenshot }) {
    let cases = 0;
    await evaluate('window.__bpbProviderProbeRevision = 0; document.getElementById("bpb-map-viewport").scrollIntoView({block:"start"})');
    try {
        for (const width of [800, 320]) for (const theme of ['light', 'dark']) for (const largeText of [false, true]) {
            const label = `${width}-${theme}-${largeText ? 'large-text' : 'normal'}`;
            await evaluate(`(${configureCredits})(${JSON.stringify({ width, theme, largeText, long: false })})`);
            await evaluate(`(${selectRaster})()`);
            await until(() => evaluate(`(${readRecovery})()`), value => value.painted, `${label}: initial raster never painted`);
            const before = await evaluate(`(${readCredits})()`);
            await blockRaster();
            await evaluate(`(${selectRaster})({fresh:true})`);
            const pending = await evaluate(`(${readRecovery})()`);
            assert.equal(pending.selected, '0', `${label}: the pending map remains selected`);
            assert.equal(pending.focus, true, `${label}: pending retains keyboard focus`);
            assert.equal(pending.noticeHidden, true, `${label}: pending does not retain an old warning`);
            assertStableTerrainGeometry(before, await evaluate(`(${readCredits})()`), `${label}/pending`);
            await releaseRaster(403);
            const failed = await until(() => evaluate(`(${readRecovery})()`), value => value.selected === 'terrain' && !value.noticeHidden, `${label}: blocked tiles never produced visible recovery`);
            assert.ok(failed.retryable && failed.focus && failed.route && failed.frameVisible, `${label}: failure must preserve the map, focus and retry path`);
            assert.ok(failed.feedbackFits && failed.horizontalOverflow <= 1, `${label}: recovery feedback must wrap without clipping or horizontal scrolling: ${JSON.stringify(failed)}`);
            assert.match(failed.notice, /Select it again to retry/); assert.doesNotMatch(failed.notice, /CORS|cross-origin/);
            assertStableTerrainGeometry(before, await evaluate(`(${readCredits})()`), `${label}/failure`);
            if (screenshot) await screenshot(`terrain-provider-failure-${label}`);
            await releaseRaster(200);
            await retryWithKeyboard();
            const retry = await evaluate(`(${readRecovery})()`);
            assert.equal(retry.noticeHidden, true, `${label}: retry clears the stale warning immediately: ${JSON.stringify(retry)}`);
            assert.equal(retry.focus, true, `${label}: retry retains focus`);
            await until(() => evaluate(`(${readRecovery})()`), value => value.selected === '0' && value.painted && value.noticeHidden, `${label}: retry never painted a recovered map`);
            assertStableTerrainGeometry(before, await evaluate(`(${readCredits})()`), `${label}/recovered`);
            cases++;
        }
    } finally {
        await releaseRaster(200);
        await evaluate(`(${selectRaster})()`);
        await evaluate(`(${restoreCredits})()`);
        await evaluate('delete window.__bpbProviderProbeRevision');
        await evaluate('delete window.__bpbProviderTransform');
    }
    assert.equal(cases, 8, 'all terrain failure/retry cases must execute');
    console.log(`  - ${cases} terrain provider paths: held tiles → HTTP 403 → retry → painted map; stable geometry and focus`);
}

export async function verifyTerrainVectorPending({ evaluate, waitForStyle, releaseStyle, screenshot }) {
    await evaluate('window.__bpbProviderProbeRevision = 0');
    try {
        await evaluate(`(${configureCredits})({width:320,theme:'dark',largeText:true,long:false})`);
        await evaluate(`(${selectRaster})()`);
        const before = await evaluate(`(${readCredits})()`);
        await evaluate('(() => { const f = document.getElementById("bpb-terrain-frame"); const p = f.contentDocument.querySelector(".bpb-terrain-picker"); p.focus({preventScroll:true}); p.value = "vector"; p.dispatchEvent(new f.contentWindow.Event("change")); })()');
        await waitForStyle();
        const pending = await evaluate(`(${readRecovery})()`);
        assert.equal(pending.selected, 'vector', 'pending vector selection must not revert to terrain-only');
        assert.ok(pending.focus && pending.feedbackFits && pending.horizontalOverflow <= 1);
        assert.match(pending.notice, /Loading map/); assert.equal(pending.noticeKind, 'loading');
        assertStableTerrainGeometry(before, await evaluate(`(${readCredits})()`), 'vector/pending');
        if (screenshot) await screenshot('terrain-vector-pending');
        await releaseStyle();
        const failed = await until(() => evaluate(`(${readRecovery})()`), value => value.selected === 'terrain' && /unavailable/.test(value.notice), 'vector style failure never produced feedback');
        assert.ok(failed.focus && failed.feedbackFits && failed.horizontalOverflow <= 1);
        assertStableTerrainGeometry(before, await evaluate(`(${readCredits})()`), 'vector/failure');
        if (screenshot) await screenshot('terrain-vector-failure');
    } finally {
        await releaseStyle();
        await evaluate(`(${selectRaster})()`); await evaluate(`(${restoreCredits})()`);
        await evaluate('delete window.__bpbProviderProbeRevision; delete window.__bpbProviderTransform');
    }
    console.log('  - held vector style: retained selection, neutral loading feedback, failure recovery and stable keyboard focus');
}
