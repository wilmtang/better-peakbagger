// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { selectedReportTable, ascentReport } from '../../src/favorites/report-adapters.js';
const fixture = async name => new JSDOM(await readFile(new URL(`../fixtures/pages/${name}.html`, import.meta.url), 'utf8'),
    { url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1' });
test('peak adapter selects the nested reports, preserving native totals and other tables', async () => {
    for (const name of ['peak-rainier', 'peak-garibaldi']) {
        const dom = await fixture(name);
        const target = selectedReportTable(dom.window.document);
        assert.ok(target?.records.length);
        assert.equal(target.table.rows[0].cells.length, 6);
        assert.ok(target.records.some(record => record.climberId));
        target.table.parentElement.append(target.table.cloneNode(true));
        assert.equal(selectedReportTable(dom.window.document), null);
        dom.window.close();
    }
});
test('detail adapter requires the independent author and conceals only the dedicated report cell', async () => {
    const dom = await fixture('ascent-ignored-report');
    const doc = dom.window.document;
    const report = ascentReport(doc);
    assert.equal(report.cid, 900002);
    assert.ok(report.cell.querySelector('video'));
    assert.equal(report.cell.contains(doc.querySelector('#Gmap')), false);
    doc.querySelector('main > h2').remove();
    assert.equal(ascentReport(doc), null, 'navigation and prose are insufficient author evidence');
    dom.window.close();
});
test('legacy detail fixture without author evidence remains untouched', async () => {
    const dom = await fixture('climber-ascent');
    assert.equal(ascentReport(dom.window.document), null);
    dom.window.close();
});
