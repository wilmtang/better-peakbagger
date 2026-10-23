// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document */
import assert from 'node:assert/strict';

// Runs only in the verifier's disposable extension profile, through real APIs.
export async function prepareSignedOut(source) {
    const api = globalThis.browser || globalThis.chrome;
    const result = await api.runtime.sendMessage({ type: 'SETTINGS_PATCH', patch: {
        favoritesSource: source, enableGithubBackup: false, enable3dMap: false,
        showWeather: false, showSnotel: false, showSunMoon: false,
    } });
    if (!result?.ok) throw new Error('Signed-out settings preparation failed');
    await api.storage.local.set({
        bpbFavoriteClimbers: { schemaVersion: 1, entries: [] },
        bpbIgnoredClimbers: { schemaVersion: 1, revision: 0, entries: [] },
        bpbBuddyCache: null,
        bpbPeakReportFilter: { schemaVersion: 1, favoritesOnly: true },
    });
}

export async function verifySignedOutExtension({ configure, navigate, evaluate, wait, press, readFavorites, requests }) {
    const baseline = { buddies: requests.buddyMutations, reads: requests.buddyReports };
    for (const source of ['buddies', 'custom']) {
        await configure(source);
        await navigate();
        await wait(() => document.querySelector('.bpb-report-favorites'));
        assert.equal(await evaluate(() => [...document.querySelectorAll('div')].some(div => /^\s*Logged in:/i.test(div.textContent))), false);
        if (source === 'buddies') {
            await wait(() => [...document.querySelectorAll('#bpb-peak-report-tools a')].some(a => a.textContent === 'Sign in to Peakbagger'));
            const recovery = await evaluate(() => [...document.querySelectorAll('#bpb-peak-report-tools a')].map(a => ({ text: a.textContent, href: a.href })));
            assert.ok(recovery.some(link => link.text === 'Sign in to Peakbagger' && /\/Default\.aspx$/.test(link.href)));
            assert.ok(recovery.some(link => link.text.startsWith('Use custom favorites') && /\/options\/favorites\.html$/.test(link.href)));
            assert.equal(await evaluate(() => [...document.querySelectorAll('#bpb-peak-report-tools button')].some(b => b.textContent === 'Retry' && !b.hidden)), false);
        }
        await press('.bpb-report-favorites', 'Enter');
        await wait(() => [...document.querySelectorAll('.bpb-climber-actions-trigger')].some(button => button.getClientRects().length));
        if (source === 'custom') {
            const cid = await evaluate(() => {
                const trigger = [...document.querySelectorAll('.bpb-climber-actions-trigger')].find(button => button.getClientRects().length);
                trigger.id = 'signed-out-climber-trigger';
                return Number(new URL(trigger.closest('.bpb-climber-link').querySelector('a').href).searchParams.get('cid'));
            });
            await press('#signed-out-climber-trigger', 'Enter');
            await wait(() => {
                const card = document.getElementById('bpb-climber-card');
                const favorite = document.getElementById('bpb-climber-card-favorite');
                return card && !card.hidden && favorite && favorite.getAttribute('aria-disabled') !== 'true';
            });
            assert.equal(await evaluate(() => document.getElementById('bpb-climber-card-buddy').hidden), true);
            await press('#bpb-climber-card-favorite', 'Enter');
            await wait(() => document.getElementById('bpb-climber-card-favorite')?.getAttribute('aria-pressed') === 'true'
                && document.getElementById('bpb-climber-card-favorite')?.getAttribute('aria-busy') === 'false');
            assert.ok((await readFavorites()).some(entry => entry.cid === cid), 'signed-out Favorite must persist through the actual worker');
        }
    }
    assert.deepEqual({ buddies: requests.buddyMutations, reads: requests.buddyReports }, baseline,
        'signed-out filters and local Favorite must not read or mutate a Buddy List');
}
