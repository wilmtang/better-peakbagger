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
