// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evalBundle, loadPage, PAGE_FIXTURES, waitFor } from '../helpers/load-page.mjs';

const PAGE_URL = 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=900001&j=-1&y=9999';
const YEAR_PAGE_URL = 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=900001&y=2024';
const editHtml = await readFile(new URL('../fixtures/pages/climber-ascentedit.html', import.meta.url), 'utf8');
const listHtml = await readFile(new URL('../fixtures/pages/climber-ascents.html', import.meta.url), 'utf8');

const prepareRuntime = (dom, handler) => {
    dom.window.chrome.runtime.sendMessage = (message, callback) => {
        const response = handler(message);
        if (callback) callback(response);
        return Promise.resolve(response);
    };
};

test('owned lists show a restrained full-profile backup entry point', async () => {
    const dom = await loadPage('climber-ascents.html', {
        fixtures: PAGE_FIXTURES,
        url: YEAR_PAGE_URL,
        bundles: ['content/profile-backup.js'],
        prepare: dom => prepareRuntime(dom, message => message.type === 'GITHUB_BACKUP_STATUS'
            ? { enabled: true, connected: true, repo: { fullName: 'me/backup' } }
            : null),
    });
    await waitFor(dom, () => dom.window.document.getElementById('bpb-profile-backup'));
    const panel = dom.window.document.getElementById('bpb-profile-backup');
    assert.match(panel.textContent, /Back up your Peakbagger profile/);
    assert.match(panel.textContent, /every ascent from every year/);
    assert.match(panel.textContent, /even when this page shows only one year/);
    assert.match(panel.textContent, /me\/backup/);
    assert.equal(panel.querySelector('.bpb-profile-primary').textContent, 'Back up all ascents');

    [...panel.querySelectorAll('button')].find(control => control.textContent === 'Refresh all').click();
    assert.match(panel.textContent, /Refresh every ascent\?/);
    assert.match(panel.textContent, /every ascent from every year/);
    assert.match(panel.textContent, /groups of up to 10/);
});

test('profile backup stays above an already-rendered beta filter', async () => {
    const dom = await loadPage('climber-ascents.html', {
        fixtures: PAGE_FIXTURES,
        url: YEAR_PAGE_URL,
        bundles: ['content/ascent-filter.js'],
        prepare: dom => prepareRuntime(dom, message => message.type === 'GITHUB_BACKUP_STATUS'
            ? { enabled: true, connected: true, repo: { fullName: 'me/backup' } }
            : null),
    });
    await waitFor(dom, () => dom.window.document.getElementById('pbaf-bar'));
    await evalBundle(dom.window, 'content/profile-backup.js');
    await waitFor(dom, () => dom.window.document.getElementById('bpb-profile-backup'));

    const panel = dom.window.document.getElementById('bpb-profile-backup');
    const filter = dom.window.document.getElementById('pbaf-bar');
    assert.equal(panel.nextElementSibling, filter);
});

test('public or mismatched climber lists never show profile backup', async () => {
    const dom = await loadPage('climber-ascents.html', {
        fixtures: PAGE_FIXTURES,
        url: 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=123',
        bundles: ['content/profile-backup.js'],
        prepare: dom => prepareRuntime(dom, () => ({ enabled: true, connected: true, repo: { fullName: 'me/backup' } })),
    });
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    assert.equal(dom.window.document.getElementById('bpb-profile-backup'), null);
});

test('starting from a one-year page fetches the owner\'s complete all-years list', async () => {
    let requestedUrl = '';
    const dom = await loadPage('climber-ascents.html', {
        fixtures: PAGE_FIXTURES,
        url: YEAR_PAGE_URL,
        bundles: ['content/profile-backup.js'],
        prepare: dom => {
            const folders = [...dom.window.document.querySelectorAll('a[href*="/ascent.aspx?aid="]')]
                .map(anchor => `ascent-a${new dom.window.URL(anchor.href).searchParams.get('aid')}`);
            prepareRuntime(dom, message => {
                if (message.type === 'GITHUB_BACKUP_STATUS') {
                    return { enabled: true, connected: true, repo: { fullName: 'me/backup' } };
                }
                if (message.type === 'GITHUB_BACKUP_PROFILE_STATUS') return { ok: true, folders };
                return null;
            });
            dom.window.fetch = async url => {
                requestedUrl = String(url);
                return {
                    ok: true,
                    status: 200,
                    url: requestedUrl,
                    headers: { get: () => null },
                    text: async () => listHtml,
                };
            };
        },
    });
    await waitFor(dom, () => dom.window.document.getElementById('bpb-profile-backup'));
    dom.window.document.querySelector('.bpb-profile-primary').click();
    await waitFor(dom, () => requestedUrl);

    const requested = new URL(requestedUrl);
    assert.equal(requested.searchParams.get('cid'), '900001');
    assert.equal(requested.searchParams.get('j'), '-1');
    assert.equal(requested.searchParams.get('y'), '9999');
});

test('profile preflight shows GitHub\'s specific failure detail', async () => {
    const dom = await loadPage('climber-ascents.html', {
        fixtures: PAGE_FIXTURES,
        url: PAGE_URL,
        bundles: ['content/profile-backup.js'],
        prepare: dom => prepareRuntime(dom, message => {
            if (message.type === 'GITHUB_BACKUP_STATUS') {
                return { enabled: true, connected: true, repo: { fullName: 'me/backup' } };
            }
            if (message.type === 'GITHUB_BACKUP_PROFILE_STATUS') {
                return { ok: false, error: { code: 'unknown', message: 'Repository service is temporarily unavailable.' } };
            }
            return null;
        }),
    });
    await waitFor(dom, () => dom.window.document.getElementById('bpb-profile-backup'));
    dom.window.document.querySelector('.bpb-profile-primary').click();
    await waitFor(dom, () => /Repository service is temporarily unavailable/.test(
        dom.window.document.getElementById('bpb-profile-backup').textContent));
    assert.doesNotMatch(dom.window.document.getElementById('bpb-profile-backup').textContent, /something went wrong/i);
});

test('one missing ascent is fetched from its edit form and sent as a direct profile snapshot', async () => {
    const sent = [];
    const dom = await loadPage('climber-ascents.html', {
        fixtures: PAGE_FIXTURES,
        url: PAGE_URL,
        bundles: ['content/profile-backup.js'],
        prepare: dom => {
            const aids = [...dom.window.document.querySelectorAll('a[href*="/ascent.aspx?aid="]')]
                .map(anchor => Number(new dom.window.URL(anchor.href).searchParams.get('aid')));
            const existing = aids.slice(1).map(aid => `2020-01-01-peak-a${aid}`);
            prepareRuntime(dom, message => {
                sent.push(message);
                if (message.type === 'GITHUB_BACKUP_STATUS') return { enabled: true, connected: true, repo: { fullName: 'me/backup' } };
                if (message.type === 'GITHUB_BACKUP_PROFILE_STATUS') return { ok: true, enabled: true, connected: true, folders: existing };
                if (message.type === 'GITHUB_BACKUP_PROFILE_BATCH') return { ok: true, result: { count: message.entries.length } };
                return null;
            });
            dom.window.fetch = async url => ({
                ok: true,
                status: 200,
                url: String(url),
                headers: { get: () => null },
                text: async () => editHtml,
            });
        },
    });
    await waitFor(dom, () => dom.window.document.getElementById('bpb-profile-backup'));
    dom.window.document.querySelector('.bpb-profile-primary').click();
    await waitFor(dom, () => /Profile backup complete/.test(dom.window.document.getElementById('bpb-profile-backup').textContent));

    const push = sent.find(message => message.type === 'GITHUB_BACKUP_PROFILE_BATCH');
    assert.ok(push);
    assert.equal(push.entries.length, 1);
    assert.equal(push.entries[0].aid, 9100001);
    assert.equal(push.entries[0].snapshot.ascent.id, 9100001);
    assert.equal(push.entries[0].snapshot.ascent.date, '2020-01-01');
    assert.equal(push.entries[0].snapshot.peak.id, 990001);
    assert.equal(push.entries[0].snapshot.peak.name, 'Sample Peak 1');
    assert.equal(push.entries[0].gpx, null);
    assert.match(dom.window.document.getElementById('bpb-profile-backup').textContent, /Backed up 1; skipped 37; failed 0/);
});

test('a GPS-flagged ascent fetches its track from the current GPXFile endpoint', async () => {
    const gpxBody = '<?xml version="1.0"?><gpx version="1.1" creator="Peakbagger.com"><trk/></gpx>';
    const requested = [];
    const sent = [];
    const dom = await loadPage('climber-ascents.html', {
        fixtures: PAGE_FIXTURES,
        url: PAGE_URL,
        bundles: ['content/profile-backup.js'],
        prepare: dom => {
            // Give the first ascent a GPS-track marker so loadAscent takes the
            // track branch; the list fixture otherwise carries no GPS rows.
            const firstAscent = dom.window.document.querySelector('a[href*="/ascent.aspx?aid=9100001"]');
            const marker = dom.window.document.createElement('img');
            marker.setAttribute('src', 'https://www.peakbagger.com/image/GPS.gif');
            marker.setAttribute('title', 'Ascent has GPS track');
            firstAscent.closest('tr').cells[0].appendChild(marker);

            const aids = [...dom.window.document.querySelectorAll('a[href*="/ascent.aspx?aid="]')]
                .map(anchor => Number(new dom.window.URL(anchor.href).searchParams.get('aid')));
            // Everything except the GPS-flagged first ascent is already backed up.
            const existing = aids.slice(1).map(aid => `2020-01-01-peak-a${aid}`);
            prepareRuntime(dom, message => {
                sent.push(message);
                if (message.type === 'GITHUB_BACKUP_STATUS') return { enabled: true, connected: true, repo: { fullName: 'me/backup' } };
                if (message.type === 'GITHUB_BACKUP_PROFILE_STATUS') return { ok: true, enabled: true, connected: true, folders: existing };
                if (message.type === 'GITHUB_BACKUP_PROFILE_BATCH') return { ok: true, result: { count: message.entries.length } };
                return null;
            });
            dom.window.fetch = async url => {
                const href = String(url);
                requested.push(href);
                const isGpx = /GPXFile\.aspx/i.test(href);
                return {
                    ok: true,
                    status: 200,
                    url: href,
                    headers: { get: name => (isGpx && /content-type/i.test(name) ? 'text/gpx; charset=utf-8' : null) },
                    text: async () => (isGpx ? gpxBody : editHtml),
                };
            };
        },
    });
    await waitFor(dom, () => dom.window.document.getElementById('bpb-profile-backup'));
    dom.window.document.querySelector('.bpb-profile-primary').click();
    await waitFor(dom, () => /Profile backup complete/.test(dom.window.document.getElementById('bpb-profile-backup').textContent));

    const gpxRequest = requested.find(href => /GPXFile\.aspx/i.test(href));
    assert.ok(gpxRequest, 'the track is fetched from the renamed endpoint');
    const gpxUrl = new URL(gpxRequest);
    assert.equal(gpxUrl.pathname, '/climber/GPXFile.aspx');
    assert.equal(gpxUrl.searchParams.get('aid'), '9100001');
    assert.equal(gpxUrl.searchParams.get('sep'), '1');
    assert.ok(!requested.some(href => /GetAscentGPX\.aspx/i.test(href)), 'the dead endpoint is never requested');

    const push = sent.find(message => message.type === 'GITHUB_BACKUP_PROFILE_BATCH');
    assert.ok(push);
    assert.equal(push.entries.length, 1);
    assert.equal(push.entries[0].aid, 9100001);
    assert.equal(push.entries[0].gpx, gpxBody);
    assert.match(dom.window.document.getElementById('bpb-profile-backup').textContent, /Backed up 1; skipped 37; failed 0/);
});

test('a 200 error page for the track fails with an honest, redirect-naming reason', async () => {
    const dom = await loadPage('climber-ascents.html', {
        fixtures: PAGE_FIXTURES,
        url: PAGE_URL,
        bundles: ['content/profile-backup.js'],
        prepare: dom => {
            const firstAscent = dom.window.document.querySelector('a[href*="/ascent.aspx?aid=9100001"]');
            const marker = dom.window.document.createElement('img');
            marker.setAttribute('src', 'https://www.peakbagger.com/image/GPS.gif');
            marker.setAttribute('title', 'Ascent has GPS track');
            firstAscent.closest('tr').cells[0].appendChild(marker);

            const aids = [...dom.window.document.querySelectorAll('a[href*="/ascent.aspx?aid="]')]
                .map(anchor => Number(new dom.window.URL(anchor.href).searchParams.get('aid')));
            const existing = aids.slice(1).map(aid => `2020-01-01-peak-a${aid}`);
            prepareRuntime(dom, message => {
                if (message.type === 'GITHUB_BACKUP_STATUS') return { enabled: true, connected: true, repo: { fullName: 'me/backup' } };
                if (message.type === 'GITHUB_BACKUP_PROFILE_STATUS') return { ok: true, enabled: true, connected: true, folders: existing };
                if (message.type === 'GITHUB_BACKUP_PROFILE_BATCH') return { ok: true, result: { count: message.entries.length } };
                return null;
            });
            dom.window.fetch = async url => {
                const href = String(url);
                // The renamed endpoint's old name 302s to a 200 HTML error page;
                // reproduce the redirected error the runner must classify.
                if (/GPXFile\.aspx/i.test(href)) {
                    return {
                        ok: true,
                        status: 200,
                        redirected: true,
                        url: 'https://www.peakbagger.com/PBError.aspx?aspxerrorpath=/climber/GPXFile.aspx',
                        headers: { get: name => (/content-type/i.test(name) ? 'text/html; charset=utf-8' : null) },
                        text: async () => '<html><head><title>Error - Peakbagger.com</title></head><body>Something went wrong.</body></html>',
                    };
                }
                return { ok: true, status: 200, url: href, headers: { get: () => null }, text: async () => editHtml };
            };
        },
    });
    await waitFor(dom, () => dom.window.document.getElementById('bpb-profile-backup'));
    dom.window.document.querySelector('.bpb-profile-primary').click();
    await waitFor(dom, () => /Profile backup complete/.test(dom.window.document.getElementById('bpb-profile-backup').textContent));

    const panel = dom.window.document.getElementById('bpb-profile-backup');
    assert.match(panel.textContent, /Backed up 0; skipped 37; failed 1/);
    assert.match(panel.textContent, /Peakbagger returned an unexpected page instead of the GPS track/);
    assert.match(panel.textContent, /redirected to PBError\.aspx/);
    assert.doesNotMatch(panel.textContent, /HTTP 200/);
});

test('a GitHub write error pauses visibly and resume retries the same ascent', async () => {
    const pushed = [];
    const dom = await loadPage('climber-ascents.html', {
        fixtures: PAGE_FIXTURES,
        url: PAGE_URL,
        bundles: ['content/profile-backup.js'],
        prepare: dom => {
            const aids = [...dom.window.document.querySelectorAll('a[href*="/ascent.aspx?aid="]')]
                .map(anchor => Number(new dom.window.URL(anchor.href).searchParams.get('aid')));
            const existing = aids.slice(1).map(aid => `2020-01-01-peak-a${aid}`);
            prepareRuntime(dom, message => {
                if (message.type === 'GITHUB_BACKUP_STATUS') return { enabled: true, connected: true, repo: { fullName: 'me/backup' } };
                if (message.type === 'GITHUB_BACKUP_PROFILE_STATUS') return { ok: true, enabled: true, connected: true, folders: existing };
                if (message.type === 'GITHUB_BACKUP_PROFILE_BATCH') {
                    pushed.push(Array.from(message.entries, entry => entry.aid));
                    return pushed.length === 1
                        ? { ok: false, error: { code: 'rate-limit', message: 'API rate limit exceeded.' } }
                        : { ok: true, result: { isUpdate: false } };
                }
                return null;
            });
            dom.window.fetch = async url => ({
                ok: true,
                status: 200,
                url: String(url),
                headers: { get: () => null },
                text: async () => editHtml,
            });
        },
    });
    await waitFor(dom, () => dom.window.document.getElementById('bpb-profile-backup'));
    dom.window.document.querySelector('.bpb-profile-primary').click();
    await waitFor(dom, () => /GitHub backup paused/.test(dom.window.document.getElementById('bpb-profile-backup').textContent));

    const panel = dom.window.document.getElementById('bpb-profile-backup');
    assert.match(panel.textContent, /GitHub is temporarily rate-limiting requests/);
    assert.match(panel.textContent, /1-ascent batch is still ready/);
    assert.match(panel.textContent, /Resume will retry it/);
    assert.deepEqual(pushed, [[9100001]]);

    [...panel.querySelectorAll('button')].find(control => control.textContent === 'Resume').click();
    await waitFor(dom, () => /Profile backup complete/.test(panel.textContent));
    assert.deepEqual(pushed, [[9100001], [9100001]]);
    assert.match(panel.textContent, /Backed up 1; skipped 37; failed 0/);
});
