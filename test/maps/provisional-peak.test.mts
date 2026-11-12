// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, PAGE_FIXTURES } from '../helpers/load-page.mjs';
import type { TestWindow } from '../helpers/page-types.mts';

// The JavaScript helper infers `prepare: null`; state the callback it accepts.
const openPage = loadPage as unknown as (fixture: string, options: Record<string, unknown>)
    => Promise<{ window: TestWindow }>;

// Provisional Peaks (negative pid) share the native coordinate row, map table
// and Links section with main peaks; every peak card must mount on them too.
const URL_PROVISIONAL = 'https://www.peakbagger.com/peak.aspx?pid=-34225';
const BUNDLES = ['content/peak-cards.js', 'content/peak-links.js', 'content/peak-weather.js',
    'content/summit-cloud.js', 'content/peak-snow.js'];

const waitFor = async (predicate: () => unknown, label: string) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
};

test('provisional peaks mount links, weather, cloud and snow cards for their own summit', async () => {
    const requests: string[] = [];
    const dom = await openPage('peak-provisional.html', {
        url: URL_PROVISIONAL, fixtures: PAGE_FIXTURES, bundles: BUNDLES,
        prepare: ({ window }: { window: TestWindow }) => {
            // Record provider requests without answering them: this test is
            // about mounting and identity, not provider rendering.
            window.fetch = (url: RequestInfo | URL) => { requests.push(String(url)); return new Promise<Response>(() => {}); };
        },
    });
    try {
        const doc = dom.window.document;
        await waitFor(() => ['bpb-peak-weather', 'bpb-summit-cloud', 'bpb-peak-snow']
            .every(id => doc.getElementById(id)?.closest('tr')?.hidden === false), 'visible weather, cloud and snow cards');

        const map = doc.getElementById('Gmap')!;
        for (const id of ['bpb-peak-weather', 'bpb-summit-cloud', 'bpb-peak-snow']) {
            assert.equal(doc.querySelectorAll(`#${id}`).length, 1, id);
            assert.equal(doc.getElementById(id)!.closest('table'), map.closest('table'), `${id} joins the native map table`);
        }

        const links = [...doc.querySelectorAll<HTMLElement>('#bpb-peak-links [data-link-key]')];
        assert.deepEqual(links.map(item => item.dataset.linkKey), ['windy', 'copernicus', 'airnow', 'avalanche'],
            'the Country row gates US-only links');
        assert.equal(links[0].querySelector('a')!.getAttribute('href'), 'https://www.windy.com/47.548914/-120.751269');
        const mapLinks = doc.getElementById('bpb-peak-map-links')!;
        assert.equal(mapLinks.closest('tr')!.cells[0].textContent, 'Web Map Links');
        assert.equal(new URL(mapLinks.querySelector('a')!.href).searchParams.get('loc'), '13/-120.751269/47.548914');

        // Forecast requests target the decimal summit, never the DMS line.
        await waitFor(() => requests.some(url => url.includes('open-meteo')), 'a forecast request');
        const forecast = new URL(requests.find(url => url.includes('open-meteo'))!);
        assert.equal(forecast.searchParams.get('latitude'), '47.548914');
        assert.equal(forecast.searchParams.get('longitude'), '-120.751269');
    } finally {
        dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
        dom.window.close();
    }
});
