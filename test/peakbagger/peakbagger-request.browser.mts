// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPeakbaggerDocument } from '../../src/peakbagger/peakbagger-request.ts';

const URL = 'https://www.peakbagger.com/report/report.aspx?r=b';
const BUDDIES = `<!doctype html><html><body>
    <a href="/climber/ClimbListC.aspx?cid=77">My Ascents</a>
    <h1>Buddy List</h1><table id="RGridView"><tr><td>Buddy</td></tr></table>
</body></html>`;

test('fetchPeakbaggerDocument parses validated responses with the browser DOMParser', async () => {
    const success = await fetchPeakbaggerDocument(URL, {
        kind: 'buddies',
        parser: DOMParser,
        fetchFn: async () => ({
            ok: true,
            status: 200,
            url: URL,
            redirected: false,
            headers: new Headers(),
            text: async () => BUDDIES,
        }) as unknown as Response,
    });
    assert.equal(success.kind, 'ok');
    assert.ok(success.document!.querySelector('#RGridView'));
});
