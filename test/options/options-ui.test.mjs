import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { settingsTransfer } from '../../src/settings/settings-transfer.js';
import {
    loadOptions, loadDraftsPage, loadFavoritesPage, el, readBlob,
    optionsCss, waitFor, registerCleanup, root, evalBundle
} from '../helpers/options-helpers.mjs';

registerCleanup();

const installSettingsFileWorker = (chrome, {
    exportFailure = () => false,
} = {}) => {
    chrome.runtime.sendMessage = async message => {
        if (message.type === 'SETTINGS_FILE_EXPORT') {
            if (exportFailure()) {
                return {
                    ok: false,
                    error: {
                        code: 'settings-unavailable',
                        message: 'Settings and API keys could not be read, so no export was created.',
                    },
                };
            }
            const settings = (await chrome.storage.sync.get('bpbSettings')).bpbSettings;
            const imgbb = (await chrome.storage.local.get('bpbImgbbAuth')).bpbImgbbAuth;
            const exportedAt = '2026-07-30T12:00:00.000Z';
            return {
                ok: true,
                content: settingsTransfer.serialize(settingsTransfer.buildPayload(settings, {
                    extensionVersion: '3.3.0',
                    exportedAt,
                    apiKeys: { imgbb: imgbb?.key || null },
                })),
                exportedAt,
            };
        }
        if (message.type === 'SETTINGS_FILE_IMPORT') {
            const parsed = settingsTransfer.parse(message.content);
            if (!parsed.ok) return { ok: false, error: { code: 'invalid-file' } };
            try {
                await chrome.storage.sync.set({ bpbSettings: parsed.settings });
                if (Object.hasOwn(parsed, 'apiKeys')) {
                    if (parsed.apiKeys.imgbb) {
                        await chrome.storage.local.set({
                            bpbImgbbAuth: {
                                key: parsed.apiKeys.imgbb,
                                savedAt: '2026-07-30T12:00:00.000Z',
                            },
                        });
                    } else {
                        await chrome.storage.local.remove('bpbImgbbAuth');
                    }
                }
                return { ok: true, settings: parsed.settings };
            } catch {
                return {
                    ok: false,
                    error: { code: 'import-failed', message: 'Settings could not be imported. Nothing was changed.' },
                };
            }
        }
        if (message.type === 'PHOTO_IMGBB_STATUS') {
            const imgbb = (await chrome.storage.local.get('bpbImgbbAuth')).bpbImgbbAuth;
            return { ok: true, configured: !!imgbb, permissionGranted: true };
        }
        if (message.type === 'GITHUB_AUTH_STATUS') return {};
        return {};
    };
};

test('theme bootstrap loads before the options stylesheet', async () => {
    const dom = await loadOptions({});
    const resources = Array.from(dom.window.document.head.querySelectorAll('script[src], link[rel="stylesheet"]'))
        .map(node => node.getAttribute('src') || node.getAttribute('href'));
    // The shared panel stylesheet comes first so page rules of equal
    // specificity win, and both come after the theme bootstrap.
    assert.deepEqual(resources, ['options-head.js', '../css/panel.css', 'options.css']);
});

// Settings and Photo Topos each used to declare their own :root palette, and
// they drifted into two different-looking products. The palette now has one
// home; a page stylesheet that re-declares a token has started a third.
test('the settings pages take their palette from the shared panel stylesheet', async () => {
    assert.doesNotMatch(optionsCss, /^\s*--(bg|card|border|text|sub|accent|link|danger|shadow):/m);
    assert.doesNotMatch(optionsCss, /:root/);
});

test('cached dark theme is applied before the asynchronous settings read', async () => {
    const dom = await loadOptions({ theme: 'dark' }, { cachedTheme: 'dark' });
    assert.equal(dom.initialTheme, 'dark');
    assert.equal(dom.window.document.documentElement.getAttribute('data-bpb-theme'), 'dark');
});

test('the authoritative theme refreshes the pre-paint cache', async () => {
    const dom = await loadOptions({ theme: 'dark' });
    assert.equal(dom.window.document.documentElement.getAttribute('data-bpb-theme'), 'dark');
    assert.equal(dom.window.localStorage.getItem('bpbThemePref'), 'dark');
});

test('a failed setting write restores the authoritative control value', async () => {
    const dom = await loadOptions({ theme: 'dark' });
    dom.chrome.storage.sync.get = async () => { throw new Error('sync read failed'); };
    dom.chrome.storage.sync.set = async () => { throw new Error('sync write failed'); };
    const theme = el(dom, 'theme');
    theme.value = 'light';
    theme.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => /couldn’t be saved/i.test(el(dom, 'status-error-text').textContent));

    assert.equal(theme.value, 'dark');
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');
    assert.equal(dom.window.document.documentElement.getAttribute('data-bpb-theme'), 'dark');
});
test('settings are grouped by the surface they affect', async () => {
    const dom = await loadOptions({});
    const sections = Array.from(dom.window.document.querySelectorAll('.settings-section'));
    assert.deepEqual(sections.map(section => section.querySelector('h2').textContent), [
        'General',
        'Activity creation',
        'Map & GPX chart',
        'Ascent beta filter',
        'Favorite climbers',
        'Backup & sync',
        'About'
    ]);

    const [general, capture, mapChart, beta, favorites, github, about] = sections;
    assert.ok(github.querySelector('#enable-github-backup'));
    assert.ok(github.querySelector('#github-panel'));
    assert.match(github.querySelector('#github-backup .desc').textContent, /manual backup controls/i);
    // Every settings section is labelled by its heading and carries at least
    // one card; About is informational, not a card.
    for (const section of [general, capture, mapChart, beta, favorites, github]) {
        const heading = section.querySelector('h2');
        assert.equal(section.getAttribute('aria-labelledby'), heading.id);
        assert.ok(section.querySelector('.card'), 'the section carries a settings card');
    }
    assert.equal(about.getAttribute('aria-labelledby'), about.querySelector('h2').id);
    assert.ok(about.querySelector('.about-version'));
    // Everything a trip report needs while creating an ascent lives in one
    // section: the editor, the photo credential, and the local drafts.
    // The drafts themselves moved to their own page — they are records to
    // manage, not settings — but the anchor stays so existing #drafts links
    // still land on the topic, one click from the manager.
    const drafts = capture.querySelector('#drafts');
    assert.equal(drafts.id, 'drafts', 'the established deep-link anchor stays stable');
    assert.equal(drafts.querySelector('#drafts-list'), null, 'the list is not a setting');
    assert.equal(drafts.querySelector('#open-draft-manager').getAttribute('href'), 'drafts.html');
    assert.match(mapChart.querySelector('label[for="units"] .desc').textContent, /processing summaries/);
    // The custom-list workspace moved to its own page; Settings keeps the
    // anchor and links out, the way trip report drafts do.
    assert.equal(favorites.querySelector('input[value="custom"]'), null, 'the list is not a setting');
    assert.equal(favorites.querySelector('#open-favorites').getAttribute('href'), 'favorites.html');
    assert.equal(github.querySelector('#github-connection-heading').textContent, 'GitHub connection');
    assert.equal(dom.window.document.querySelector('.side-nav a[href="#github"]').textContent,
        'Backup & sync');
    assert.equal(github.id, 'github', 'the established deep-link anchor stays stable');

    assert.ok(general.querySelector('#theme'));
    assert.ok(general.querySelector('#enable-3d-map'));
    assert.equal(general.querySelector('#units'), null);
    // The trip-report controls moved out of General into Activity creation.
    assert.equal(general.querySelector('#enable-report-editor'), null);
    assert.equal(general.querySelector('#add-report-credit'), null);

    // Activity creation → GPX capture / TR editor
    assert.deepEqual(
        [...capture.querySelectorAll('.subsection-title')].map(heading => heading.textContent),
        ['GPX capture', 'TR editor', 'TR photos', 'TR drafts'],
    );
    assert.deepEqual(
        [...dom.window.document.querySelectorAll('.side-nav a.nav-subitem[href^="#capture-"],'
            + ' .side-nav a.nav-subitem[href="#drafts"]')].map(link => link.textContent),
        ['GPX capture', 'TR editor', 'TR photos', 'TR drafts'],
    );
    assert.equal(capture.querySelector('#capture-report .title').textContent, 'TR editor');
    for (const id of ['retain-waypoints', 'fill-ascent-details', 'fill-trip-info', 'fill-wilderness-nights', 'fill-external-url']) {
        assert.ok(capture.querySelector(`#capture-gpx #${id}`), `${id} should belong to GPX capture`);
    }
    for (const id of ['enable-report-editor', 'add-report-credit']) {
        assert.ok(capture.querySelector(`#capture-report #${id}`), `${id} should belong to TR editor`);
    }
    assert.ok(capture.querySelector('#capture-photos #imgbb-key'),
        'the ImgBB key should belong to TR photos');
    // Map & GPX chart → GPX chart / Map
    for (const id of ['units', 'chart-series']) {
        assert.ok(mapChart.querySelector(`#map-chart-chart #${id}`), `${id} should belong to GPX chart`);
    }
    for (const id of ['map-route-color', 'remember-map-layer', 'terrain-cache-limit', 'map-viewport-width']) {
        assert.ok(mapChart.querySelector(`#map-chart-map #${id}`), `${id} should belong to Map`);
    }
    const outlineColor = mapChart.querySelector('#map-route-casing-color');
    const outlineWidth = mapChart.querySelector('#map-route-casing-width');
    assert.equal(outlineColor.previousElementSibling.textContent, 'Outline');
    assert.equal(outlineColor.getAttribute('aria-label'), 'Route outline color');
    assert.equal(outlineWidth.getAttribute('aria-label'), 'Route outline width in pixels');
    for (const id of ['beta-tr', 'beta-tr-words', 'beta-gps', 'beta-link', 'beta-sort-date-desc']) {
        assert.ok(beta.querySelector(`#${id}`), `${id} should belong to Ascent beta filter`);
    }
    // The custom-list workspace moved to its own page; Settings keeps only a
    // link to it, and its GitHub backup below.
    assert.equal(favorites.querySelector('#favorites-buddy-panel'), null);
    assert.equal(favorites.querySelector('#favorites-list'), null);
    assert.equal(favorites.querySelector('#open-favorites').getAttribute('href'), 'favorites.html');
    assert.ok(github.querySelector('#github-favorites-backup #favorites-restore'),
        'the favorites GitHub backup stays in Backup & sync');
    assert.ok(github.querySelector('#github-backup #enable-github-backup'), 'GitHub backup lives in its subsection');
    assert.ok(github.querySelector('#github-settings-backup #settings-backup-export'));
    assert.ok(github.querySelector('#github-settings-backup #settings-backup-import'));
    // Favorites backup is a Backup & sync concern, not part of the list editor.
    assert.equal(favorites.querySelector('#favorites-backup'), null);
    for (const id of ['favorites-github-status', 'favorites-backup', 'favorites-restore', 'favorites-auto-backup']) {
        assert.ok(github.querySelector(`#github-favorites-backup #${id}`),
            `${id} should belong to Favorite climbers backup`);
    }
});

test('trip report photo and draft settings follow the editor option', async () => {
    const dom = await loadOptions({ enableReportEditor: false });
    const doc = dom.window.document;
    const dependentSections = ['capture-photos', 'drafts'].map(id => el(dom, id));
    const dependentNavItems = ['#capture-photos', '#drafts'].map(href =>
        doc.querySelector(`.side-nav a[href="${href}"]`).closest('li'));

    assert.ok([...dependentSections, ...dependentNavItems].every(element => element.hidden),
        'editor-only settings and their navigation should start hidden');

    const editorToggle = el(dom, 'enable-report-editor');
    editorToggle.checked = true;
    editorToggle.dispatchEvent(new dom.window.Event('change'));
    assert.ok([...dependentSections, ...dependentNavItems].every(element => !element.hidden),
        'dependent settings should appear immediately when the editor is enabled');
    await waitFor(dom, () => dom.chrome._store.bpbSettings.enableReportEditor === true);

    editorToggle.checked = false;
    editorToggle.dispatchEvent(new dom.window.Event('change'));
    assert.ok([...dependentSections, ...dependentNavItems].every(element => element.hidden),
        'dependent settings should disappear immediately when the editor is disabled');
    await waitFor(dom, () => dom.chrome._store.bpbSettings.enableReportEditor === false);
});

test('only interactive setting labels advertise a pointer cursor', async () => {
    const dom = await loadOptions({});
    const style = dom.window.document.createElement('style');
    style.textContent = optionsCss;
    dom.window.document.head.append(style);

    assert.equal(dom.window.getComputedStyle(
        dom.window.document.querySelector('label.label[for="theme"]')
    ).cursor, 'pointer');
    assert.notEqual(dom.window.getComputedStyle(
        dom.window.document.querySelector('div.label')
    ).cursor, 'pointer');
});

test('options sections log the missing ids before degrading to no-op controllers', async () => {
    const errors = [];
    await loadOptions({}, {
        prepareWindow(window) {
            for (const id of [
                'github-panel', 'settings-backup-export', 'favorites-github-status'
            ]) window.document.getElementById(id).remove();
            window.console.error = message => errors.push(String(message));
        }
    });

    assert.equal(errors.length, 3);
    assert.ok(errors.some(message => /GitHub settings.*github-panel/.test(message)));
    assert.ok(errors.some(message => /settings backup.*settings-backup-export/.test(message)));
    assert.ok(errors.some(message => /favorite climbers backup.*favorites-github-status/.test(message)));
});

// The favorite-climbers workspace degrades the same way on its own page.
test('the favorite climbers page logs its missing ids instead of throwing', async () => {
    const errors = [];
    const dom = await loadFavoritesPage({}, {});
    dom.window.console.error = message => errors.push(String(message));
    dom.window.document.getElementById('favorites-list').remove();
    await evalBundle(dom.window, 'options/favorites-page.js');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /favorite climbers.*favorites-list/);
});

// The draft manager degrades the same way on its own page.
test('the draft manager page logs its missing ids instead of throwing', async () => {
    const errors = [];
    const dom = await loadDraftsPage({}, {});
    dom.window.console.error = message => errors.push(String(message));
    dom.window.document.getElementById('drafts-list').remove();
    await evalBundle(dom.window, 'options/drafts-page.js');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /draft manager.*drafts-list/);
});

test('settings feedback separates severity: successes fade, failures persist and alert', async () => {
    const dom = await loadOptions({ theme: 'dark' });
    const ok = el(dom, 'status');
    const bad = el(dom, 'status-error');
    const badText = el(dom, 'status-error-text');

    // Success: the polite region, and it is scheduled to fade.
    el(dom, 'map-viewport-reset').click();
    await waitFor(dom, () => ok.textContent === 'Map size reset');
    assert.equal(ok.classList.contains('show'), true);
    assert.equal(ok.getAttribute('role'), 'status');
    assert.equal(bad.hidden, true, 'a success never lights the alert region');

    // Failure: the alert region, and it does not auto-dismiss.
    dom.chrome.storage.sync.get = async () => { throw new Error('sync read failed'); };
    dom.chrome.storage.sync.set = async () => { throw new Error('sync write failed'); };
    const theme = el(dom, 'theme');
    theme.value = 'light';
    theme.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => /couldn’t be saved/i.test(badText.textContent));

    assert.equal(bad.hidden, false);
    assert.equal(bad.classList.contains('show'), true);
    assert.equal(bad.getAttribute('role'), 'alert', 'failures are announced assertively');
    assert.equal(ok.classList.contains('show'), false, 'the success line is cleared');
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(bad.classList.contains('show'), true,
        'recovery copy must not fade out from under the user');

    // ...but it is dismissible, per the reversible-and-safe bar.
    el(dom, 'status-error-dismiss').click();
    assert.equal(bad.hidden, true);
    assert.equal(bad.classList.contains('show'), false);
});

test('the settings feedback dock stays on screen from any scroll position', async () => {
    const css = await readFile(path.join(root, 'options', 'options.css'), 'utf8');
    // The controls live thousands of pixels above the end of .content, which is
    // the scroll container; an in-flow line at the end of .wrap is never seen.
    assert.match(css, /\.status-dock\s*{[^}]*position:\s*sticky/s);
    assert.match(css, /\.status-dock\s*{[^}]*bottom:\s*0/s);
    assert.match(css, /\.status-error\s*{[^}]*color:\s*var\(--danger\)/s,
        'failures need a colour that is not the success accent');
});

test('the options controller exclusively owns shared status timing', async () => {
    const draftsSource = await readFile(path.join(root, 'options', 'drafts.js'), 'utf8');
    assert.match(draftsSource, /export const initDrafts/);
    assert.doesNotMatch(draftsSource, /getElementById\(['"]status['"]\)|2200/);
});

test('settings export downloads all known settings and the saved API key', async () => {
    const download = {};
    const dom = await loadOptions({ theme: 'dark', unknownSetting: 'private' }, {
        local: { bpbImgbbAuth: { key: 'private-imgbb-key', savedAt: '2026-07-29T12:00:00.000Z' } },
        prepareChrome: chrome => installSettingsFileWorker(chrome),
        prepareWindow(window) {
            window.URL.createObjectURL = blob => {
                download.blob = blob;
                return 'blob:settings-export';
            };
            window.URL.revokeObjectURL = url => { download.revoked = url; };
            window.HTMLAnchorElement.prototype.click = function click() {
                download.href = this.href;
                download.name = this.download;
            };
        }
    });

    el(dom, 'settings-backup-export').click();
    await waitFor(dom, () => download.blob);
    const parsed = settingsTransfer.parse(await readBlob(dom, download.blob));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.settings.theme, 'dark');
    assert.equal('unknownSetting' in parsed.settings, false);
    assert.deepEqual(parsed.apiKeys, { imgbb: 'private-imgbb-key' });
    assert.equal(download.href, 'blob:settings-export');
    assert.match(download.name, /^better-peakbagger-settings-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(download.revoked, 'blob:settings-export');
});

test('settings export creates no file when the worker cannot read every setting and retries cleanly', async () => {
    const download = { created: 0, clicked: 0 };
    let failExport = true;
    const dom = await loadOptions({ theme: 'dark' }, {
        prepareChrome(chrome) {
            installSettingsFileWorker(chrome, { exportFailure: () => failExport });
        },
        prepareWindow(window) {
            window.URL.createObjectURL = blob => {
                download.created++;
                download.blob = blob;
                return 'blob:settings-export';
            };
            window.URL.revokeObjectURL = url => { download.revoked = url; };
            window.HTMLAnchorElement.prototype.click = function click() {
                download.clicked++;
            };
        }
    });

    el(dom, 'settings-backup-export').click();
    await waitFor(dom, () => el(dom, 'status-error-text').textContent
        === 'Settings and API keys could not be read, so no export was created.');

    assert.equal(download.created, 0, 'a failed read must not serialize a partial backup');
    assert.equal(download.clicked, 0, 'a failed read must not start a download');
    assert.equal(download.revoked, undefined);

    failExport = false;
    el(dom, 'settings-backup-export').click();
    await waitFor(dom, () => download.blob);

    const parsed = settingsTransfer.parse(await readBlob(dom, download.blob));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.settings.theme, 'dark',
        'the retry must serialize the authoritative settings rather than defaults from the failed read');
    assert.equal(download.created, 1);
    assert.equal(download.clicked, 1);
    assert.equal(download.revoked, 'blob:settings-export');
});

test('settings import replaces known settings and API keys only after inline confirmation', async () => {
    const dom = await loadOptions(
        { theme: 'dark', units: 'imperial' },
        {
            local: { bpbImgbbAuth: { key: 'old-imgbb-key' } },
            prepareChrome: chrome => installSettingsFileWorker(chrome),
        }
    );
    const input = el(dom, 'settings-backup-file');
    const payload = settingsTransfer.buildPayload({ theme: 'light', units: 'metric' }, {
        extensionVersion: '3.0.0',
        exportedAt: '2026-07-22T12:00:00.000Z',
        apiKeys: { imgbb: 'new-imgbb-key' },
    });
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{ name: 'trail-settings.json', text: async () => settingsTransfer.serialize(payload) }]
    });

    input.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden === false);
    assert.match(el(dom, 'settings-backup-confirmation').textContent,
        /trail-settings\.json.*Replaces your current settings and saved API keys/s);
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark', 'reading a file must not apply it');
    assert.equal(dom.chrome._localStore.bpbImgbbAuth.key, 'old-imgbb-key');

    el(dom, 'settings-backup-confirm').click();
    await waitFor(dom, () => dom.chrome._store.bpbSettings.theme === 'light');
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden);
    assert.equal(dom.chrome._store.bpbSettings.units, 'metric');
    assert.equal(dom.chrome._localStore.bpbImgbbAuth.key, 'new-imgbb-key');
    assert.equal(el(dom, 'settings-backup-confirmation').hidden, true);
    assert.equal(el(dom, 'status').textContent, 'Settings imported');
});

test('settings import keeps its confirmation retryable when persistence fails', async () => {
    let failWrite = true;
    const dom = await loadOptions({ theme: 'dark', units: 'imperial' }, {
        prepareChrome: chrome => {
            installSettingsFileWorker(chrome);
            const nativeSet = chrome.storage.sync.set;
            chrome.storage.sync.set = async values => {
                if (failWrite && values.bpbSettings?.theme === 'light') {
                    throw new Error('sync write failed');
                }
                return nativeSet(values);
            };
        },
    });
    const input = el(dom, 'settings-backup-file');
    const payload = settingsTransfer.buildPayload({ theme: 'light', units: 'metric' }, {
        extensionVersion: '3.0.0',
        exportedAt: '2026-07-22T12:00:00.000Z'
    });
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{ name: 'trail-settings.json', text: async () => settingsTransfer.serialize(payload) }]
    });

    input.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden === false);
    el(dom, 'settings-backup-confirm').click();
    await waitFor(dom, () => /could not be imported/i.test(el(dom, 'status-error-text').textContent));

    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');
    assert.equal(el(dom, 'settings-backup-confirmation').hidden, false);
    assert.equal(dom.window.document.activeElement, el(dom, 'settings-backup-confirm'));

    failWrite = false;
    el(dom, 'settings-backup-confirm').click();
    await waitFor(dom, () => dom.chrome._store.bpbSettings.theme === 'light');
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden);
    assert.equal(el(dom, 'settings-backup-confirmation').hidden, true);
    assert.equal(dom.window.document.activeElement, el(dom, 'settings-backup-import'));
    assert.equal(el(dom, 'status').textContent, 'Settings imported');
});

test('Escape cancels a settings import and restores focus to Import', async () => {
    const dom = await loadOptions({ theme: 'dark' });
    const input = el(dom, 'settings-backup-file');
    const payload = settingsTransfer.buildPayload({ theme: 'light' }, {
        extensionVersion: '3.0.0',
        exportedAt: '2026-07-22T12:00:00.000Z'
    });
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{ name: 'trail-settings.json', text: async () => settingsTransfer.serialize(payload) }]
    });
    input.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden === false);

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
    }));

    assert.equal(el(dom, 'settings-backup-confirmation').hidden, true);
    assert.equal(dom.window.document.activeElement, el(dom, 'settings-backup-import'));
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');
});

test('Escape cannot visually cancel an import after its write has started', async () => {
    let releaseWrite;
    let writeStarted = false;
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    const dom = await loadOptions({ theme: 'dark' }, {
        prepareChrome: chrome => {
            installSettingsFileWorker(chrome);
            const nativeSet = chrome.storage.sync.set;
            chrome.storage.sync.set = async values => {
                if (values.bpbSettings?.theme === 'light') {
                    writeStarted = true;
                    await writeGate;
                }
                return nativeSet(values);
            };
        },
    });
    const input = el(dom, 'settings-backup-file');
    const payload = settingsTransfer.buildPayload({ theme: 'light' }, {
        extensionVersion: '3.0.0',
        exportedAt: '2026-07-22T12:00:00.000Z'
    });
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{ name: 'trail-settings.json', text: async () => settingsTransfer.serialize(payload) }]
    });
    input.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden === false);

    el(dom, 'settings-backup-confirm').click();
    await waitFor(dom, () => writeStarted);
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
    }));

    assert.equal(el(dom, 'settings-backup-confirmation').hidden, false);
    assert.equal(el(dom, 'settings-backup-confirmation').getAttribute('aria-busy'), 'true');
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');

    releaseWrite();
    await waitFor(dom, () => dom.chrome._store.bpbSettings.theme === 'light');
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden);
    assert.equal(el(dom, 'status').textContent, 'Settings imported');
});

test('settings import rejects invalid and newer files without changing settings', async () => {
    const dom = await loadOptions({ theme: 'dark' });
    const input = el(dom, 'settings-backup-file');
    const choose = async (name, text) => {
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [{ name, text: async () => text }]
        });
        input.dispatchEvent(new dom.window.Event('change'));
        await waitFor(dom, () => el(dom, 'status-error-text').textContent.length > 0);
    };

    await choose('notes.json', '{');
    assert.equal(el(dom, 'status-error-text').textContent, 'That is not a Better Peakbagger settings file.');
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');

    el(dom, 'status-error-text').textContent = '';
    await choose('future.json', JSON.stringify({
        kind: settingsTransfer.KIND,
        schemaVersion: settingsTransfer.SCHEMA_VERSION + 1,
        settings: {}
    }));
    assert.equal(el(dom, 'status-error-text').textContent,
        'This settings file was made by a newer version of the extension.');
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');
    assert.equal(el(dom, 'settings-backup-confirmation').hidden, true);
});
