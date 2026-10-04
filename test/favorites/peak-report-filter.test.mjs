// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, PAGE_FIXTURES, waitFor } from '../helpers/load-page.mjs';
const entry = cid => ({ cid, name: `Climber ${cid}`, addedAt: 1 });
const load = local => loadPage('peak-rainier.html', { fixtures: PAGE_FIXTURES,
    url: 'https://www.peakbagger.com/peak.aspx?pid=2296', bundles: ['content/peak-report-filter.js'],
    settings: { favoritesSource: 'custom' }, local });
const visible = dom => [...dom.window.document.querySelector('#bpb-selected-reports').rows]
    .slice(1).filter(row => row.cells.length === 6 && row.style.display !== 'none' && !row.hidden);
test('peak reports compose ignores, favorites and temporary reveal without changing membership', async () => {
    const dom = await load({ bpbIgnoredClimbers: { schemaVersion: 1, revision: 1, entries: [entry(38769)] },
        bpbFavoriteClimbers: { schemaVersion: 1, entries: [{ ...entry(38769), source: 'manual' }] } });
    await waitFor(dom, () => dom.window.document.querySelector('#bpb-selected-reports')?.style.visibility !== 'hidden'
        && dom.window.document.querySelector('#bpb-peak-report-tools .bpb-report-status[role="status"]')?.textContent);
    const total = visible(dom).length;
    const tools = dom.window.document.querySelector('#bpb-peak-report-tools');
    tools.querySelector('.bpb-report-favorites').click();
    await waitFor(dom, () => dom.chrome._localStore.bpbPeakReportFilter?.favoritesOnly === true);
    assert.equal(visible(dom).length, 0);
    const reveal = [...tools.querySelectorAll('button')].find(b => /^Show ignored/.test(b.textContent));
    reveal.click();
    assert.equal(visible(dom).length, 1);
    assert.equal(dom.chrome._localStore.bpbIgnoredClimbers.entries.length, 1);
    const full = [...tools.querySelectorAll('button')].find(b => b.textContent === 'View full list');
    full.click(); assert.equal(visible(dom).length, total + 1);
    assert.equal(dom.chrome._localStore.bpbPeakReportFilter.favoritesOnly, true);
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    assert.equal(visible(dom).length, 0);
    dom.window.close();
});
test('an active preference with empty favorites is honest, and malformed ignores leave reports readable', async () => {
    const dom = await load({ bpbPeakReportFilter: { schemaVersion: 1, favoritesOnly: true }, bpbIgnoredClimbers: { schemaVersion: 2 } });
    await waitFor(dom, () => dom.window.document.querySelector('#bpb-peak-report-tools')?.textContent.includes("Couldn't load ignored"));
    assert.equal(visible(dom).length, 0);
    const all = [...dom.window.document.querySelectorAll('#bpb-peak-report-tools button')].find(b => b.textContent === 'Show all reports');
    all.click();
    await waitFor(dom, () => visible(dom).length > 0);
    assert.ok(dom.window.document.querySelector('#bpb-peak-report-tools').textContent.includes("Couldn't load ignored climbers."));
    dom.window.close();
});
