import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    loadFavoritesPage, el, favoriteRow, waitFor, registerCleanup,
    accelerateTimeout, siteTabChrome, buddyCacheFrom, signedOutFetch,
    favoriteKey, buddyCacheKey, favoriteStore, peakbaggerFetch, pageResponse, buddyPageFixture
} from '../helpers/options-helpers.mjs';

registerCleanup();
const cloudflareBody = await readFile(new URL('../fixtures/peakbagger-managed-challenge.html', import.meta.url), 'utf8');

test('favorite removal transfers focus to Undo and restoration to the same row', async () => {
    const entries = [{ cid: 900002, name: 'First', addedAt: 2, source: 'manual' },
        { cid: 900003, name: 'Second', addedAt: 1, source: 'manual' }];
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore(entries) },
    });
    const remove = favoriteRow(dom, 900002).querySelector('[data-action="delete"]');
    remove.focus(); remove.click();
    await waitFor(dom, () => favoriteRow(dom, 900002)?.querySelector('[data-action="undo"]'));
    const undo = favoriteRow(dom, 900002).querySelector('[data-action="undo"]');
    assert.equal(dom.window.document.activeElement, undo);
    undo.click();
    await waitFor(dom, () => favoriteRow(dom, 900002)?.querySelector('[data-action="delete"]'));
    assert.equal(dom.window.document.activeElement, favoriteRow(dom, 900002).querySelector('a'));
});

test('favorite refresh retains the focused identity and leaves unrelated controls alone', async () => {
    const first = { cid: 900002, name: 'First', addedAt: 2, source: 'manual' };
    const second = { cid: 900003, name: 'Second', addedAt: 1, source: 'manual' };
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore([first, second]) },
    });
    favoriteRow(dom, first.cid).querySelector('[data-action="delete"]').focus();
    await dom.chrome.storage.local.set({ [favoriteKey]: favoriteStore([
        { ...first, name: 'First renamed', addedAt: 0 }, second,
    ]) });
    await waitFor(dom, () => favoriteRow(dom, first.cid)?.textContent.includes('First renamed'));
    assert.equal(dom.window.document.activeElement, favoriteRow(dom, first.cid).querySelector('[data-action="delete"]'));
    const search = el(dom, 'favorites-search'); search.focus();
    await dom.chrome.storage.local.set({ [favoriteKey]: favoriteStore([second]) });
    await waitFor(dom, () => !favoriteRow(dom, first.cid));
    assert.equal(dom.window.document.activeElement, search);
});

test('focused favorite Undo expiry moves to a nearby row or the search field', async () => {
    let expire;
    const entries = [{ cid: 900002, name: 'First', addedAt: 2, source: 'manual' },
        { cid: 900003, name: 'Second', addedAt: 1, source: 'manual' }];
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore(entries) }, prepareWindow: win => {
            const nativeSet = win.setTimeout.bind(win);
            win.setTimeout = (fn, ms, ...args) => ms === 6000 ? (expire = fn, -1234) : nativeSet(fn, ms, ...args);
        },
    });
    for (const cid of [900002, 900003]) {
        const remove = favoriteRow(dom, cid).querySelector('[data-action="delete"]');
        remove.focus(); remove.click();
        await waitFor(dom, () => favoriteRow(dom, cid)?.querySelector('[data-action="undo"]'));
        expire();
        assert.equal(dom.window.document.activeElement, cid === 900002
            ? favoriteRow(dom, 900003).querySelector('a') : el(dom, 'favorites-search'));
    }
});

test('favorite manager follows external source and buddy-removal settings in both directions', async () => {
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' });
    for (const source of ['buddies', 'custom']) {
        await dom.chrome.storage.sync.set({ bpbSettings: {
            ...dom.chrome._store.bpbSettings, favoritesSource: source,
            removeFavoriteWhenBuddyRemoved: source === 'buddies',
        } });
        const selected = dom.window.document.querySelector('input[name="favorites-source"]:checked');
        assert.equal(selected.value, source);
        assert.equal(el(dom, 'favorites-custom-panel').hidden, source !== 'custom');
        assert.equal(el(dom, 'favorites-remove-with-buddy').checked, source === 'buddies');
    }
});

test('a stale initial settings read cannot overwrite an external favorite-source change', async () => {
    let releaseRead;
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        prepareChrome: chrome => {
            const get = chrome.storage.sync.get;
            let reads = 0;
            chrome.storage.sync.get = async key => {
                const snapshot = await get(key);
                if (++reads === 2) await new Promise(resolve => { releaseRead = resolve; });
                return snapshot;
            };
        },
    });
    assert.equal(typeof releaseRead, 'function');
    await dom.chrome.storage.sync.set({ bpbSettings: {
        favoritesSource: 'buddies', removeFavoriteWhenBuddyRemoved: true,
    } });
    releaseRead();
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    assert.equal(dom.window.document.querySelector('input[name="favorites-source"]:checked').value, 'buddies');
    assert.equal(el(dom, 'favorites-remove-with-buddy').checked, true);
});

test('favorite setting rollback uses the latest external confirmed values', async () => {
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' });
    await dom.chrome.storage.sync.set({ bpbSettings: {
        favoritesSource: 'buddies', removeFavoriteWhenBuddyRemoved: true,
    } });
    dom.chrome.storage.sync.set = async () => { throw new Error('storage unavailable'); };
    const custom = dom.window.document.querySelector('input[name="favorites-source"][value="custom"]');
    custom.checked = true; custom.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => /couldn’t be saved/.test(el(dom, 'status-error-text').textContent));
    assert.equal(dom.window.document.querySelector('input[name="favorites-source"]:checked').value, 'buddies');
    assert.equal(el(dom, 'favorites-remove-with-buddy').checked, true);
});

test('an old setting write reply cannot replace a newer external preference', async () => {
    const dom = await loadFavoritesPage({ favoritesSource: 'buddies' });
    let finishWrite;
    const nativeSend = dom.chrome.runtime.sendMessage;
    Object.defineProperty(dom.chrome.runtime, 'sendMessage', { value: message =>
        message.type === 'SETTINGS_PATCH' ? new Promise(resolve => { finishWrite = resolve; }) : nativeSend(message),
    });
    const custom = dom.window.document.querySelector('input[name="favorites-source"][value="custom"]');
    custom.checked = true; custom.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => finishWrite);
    await dom.chrome.storage.sync.set({ bpbSettings: {
        favoritesSource: 'buddies', removeFavoriteWhenBuddyRemoved: true,
    } });
    finishWrite({ ok: true, settings: { favoritesSource: 'custom' } });
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    assert.equal(dom.window.document.querySelector('input[name="favorites-source"]:checked').value, 'buddies');
    assert.equal(el(dom, 'favorites-remove-with-buddy').checked, true);
});

test('favorite Undo explains an intervening ignore and preserves both lists', async () => {
    const entry = { cid: 900002, name: 'Casey Alpine', addedAt: 1, source: 'manual' };
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore([entry]) },
    });
    favoriteRow(dom, 900002).querySelector('[data-action="delete"]').click();
    await waitFor(dom, () => favoriteRow(dom, 900002).querySelector('[data-action="undo"]'));
    await dom.chrome.storage.local.set({ bpbIgnoredClimbers: { schemaVersion: 1, revision: 1, entries: [entry] } });
    favoriteRow(dom, 900002).querySelector('[data-action="undo"]').click();
    await waitFor(dom, () => /Unignore/.test(el(dom, 'status-error-text').textContent));
    assert.match(el(dom, 'status-error-text').textContent, /Casey Alpine.*Unignore/);
    assert.equal(dom.chrome._localStore[favoriteKey].entries.length, 0);
    assert.equal(dom.chrome._localStore.bpbIgnoredClimbers.entries[0].cid, 900002);
});

test('favorite source defaults to buddies and switching to custom persists', async () => {
    const dom = await loadFavoritesPage({});
    const buddies = dom.window.document.querySelector('input[name="favorites-source"][value="buddies"]');
    const custom = dom.window.document.querySelector('input[name="favorites-source"][value="custom"]');
    const removeWithBuddy = el(dom, 'favorites-remove-with-buddy');
    assert.equal(buddies.checked, true);
    assert.equal(el(dom, 'favorites-buddy-panel').hidden, false);
    assert.equal(el(dom, 'favorites-custom-panel').hidden, true);
    assert.equal(removeWithBuddy.checked, false, 'removing a Buddy is non-destructive by default');
    assert.match(el(dom, 'favorites-buddy-cache-hint').textContent,
        /saved copy of your Buddy List for up to 7 days/);
    assert.match(el(dom, 'favorites-buddy-cache-hint').textContent,
        /Changes made on Peakbagger may not appear immediately; choose Refresh now after editing your buddies/);

    custom.checked = true;
    custom.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => dom.chrome._store.bpbSettings.favoritesSource === 'custom');
    assert.equal(el(dom, 'favorites-buddy-panel').hidden, true);
    assert.equal(el(dom, 'favorites-custom-panel').hidden, false);

    removeWithBuddy.checked = true;
    removeWithBuddy.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => dom.chrome._store.bpbSettings.removeFavoriteWhenBuddyRemoved === true);
});

test('adding a climber by id resolves and validates the public profile', async () => {
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        prepareWindow: window => { window.fetch = peakbaggerFetch({ climberCid: 900002 }); },
    });
    el(dom, 'favorites-add-input').value = '900002';
    el(dom, 'favorites-add-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.length === 1);

    const entry = dom.chrome._localStore[favoriteKey].entries[0];
    assert.equal(entry.cid, 900002);
    assert.equal(entry.name, 'Alex Doe');
    assert.equal(entry.source, 'manual');
    assert.equal(dom.chrome._favoriteMutations.at(-1).kind, 'add');
    assert.equal(dom.chrome._favoriteMutations.at(-1).entry.cid, 900002);
    assert.equal(favoriteRow(dom, 900002).querySelector('.favorite-name').textContent, 'Alex Doe');
    assert.match(favoriteRow(dom, 900002).textContent, /#900002.*Manual/);
});

test('removing a custom favorite is reversible and list sorting is explicit', async () => {
    const entries = [
        { cid: 900002, name: 'Zulu Climber', addedAt: 20, source: 'manual' },
        { cid: 900003, name: 'Alpha Climber', addedAt: 10, source: 'buddy' },
    ];
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore(entries) },
    });
    await waitFor(dom, () => dom.window.document.querySelectorAll('.favorite-item').length === 2);
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Zulu Climber', 'Alpha Climber'], 'newest-first is the initial sort');
    el(dom, 'favorites-sort').value = 'name';
    el(dom, 'favorites-sort').dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Alpha Climber', 'Zulu Climber']);

    const remove = favoriteRow(dom, 900002).querySelector('[data-action="delete"]');
    assert.equal(remove.textContent, 'Remove');
    remove.click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey].entries.length === 1);
    assert.match(favoriteRow(dom, 900002).textContent, /Favorite removed\s*Undo/);
    favoriteRow(dom, 900002).querySelector('[data-action="undo"]').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey].entries.length === 2
        && favoriteRow(dom, 900002)?.querySelector('.favorite-name'));
    assert.equal(dom.chrome._localStore[favoriteKey].entries.some(entry => entry.cid === 900002), true);
});

test('custom favorites show a live total and fuzzy-search names and ids', async () => {
    const entries = [
        { cid: 18950, name: 'Kríshna Dase, KD', addedAt: 30, source: 'manual' },
        { cid: 900003, name: 'Nick McMillen', addedAt: 20, source: 'manual' },
        { cid: 900004, name: 'Alpine Casey', addedAt: 10, source: 'buddy' },
    ];
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore(entries) },
    });
    await waitFor(dom, () => dom.window.document.querySelectorAll('.favorite-item').length === 3);
    assert.equal(el(dom, 'favorites-count').textContent, '3 favorites');

    const search = el(dom, 'favorites-search');
    search.value = 'krsihna dse';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.equal(el(dom, 'favorites-count').textContent, '1 of 3 favorites');
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Kríshna Dase, KD']);

    search.value = '900003';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Nick McMillen']);

    search.value = 'no such climber';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.equal(el(dom, 'favorites-count').textContent, '0 of 3 favorites');
    assert.equal(el(dom, 'favorites-list').hidden, true);
    assert.equal(el(dom, 'favorites-empty').textContent, 'No favorites match “no such climber”.');
});

test('custom favorites show source counts and compose source filtering with search', async () => {
    const entries = [
        { cid: 18950, name: 'Kríshna Dase, KD', addedAt: 30, source: 'manual' },
        { cid: 900003, name: 'Nick McMillen', addedAt: 20, source: 'manual' },
        { cid: 900004, name: 'Alpine Casey', addedAt: 10, source: 'buddy' },
    ];
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore(entries) },
    });
    await waitFor(dom, () => dom.window.document.querySelectorAll('.favorite-item').length === 3);
    const filter = source => dom.window.document.querySelector(`[data-favorites-source-filter="${source}"]`);
    const sourceCount = source => filter(source).querySelector('[data-favorites-source-count]').textContent;

    assert.deepEqual(['all', 'buddy', 'manual'].map(sourceCount), ['3', '1', '2']);
    assert.equal(filter('all').getAttribute('aria-pressed'), 'true');
    assert.equal(filter('buddy').getAttribute('aria-label'), 'Show 1 favorite added from buddies');
    assert.equal(filter('manual').getAttribute('aria-label'), 'Show 2 manually added favorites');

    filter('buddy').click();
    assert.equal(filter('buddy').getAttribute('aria-pressed'), 'true');
    assert.equal(el(dom, 'favorites-count').textContent, '1 of 3 favorites');
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Alpine Casey']);

    const search = el(dom, 'favorites-search');
    search.value = 'nick';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.equal(el(dom, 'favorites-count').textContent, '0 of 3 favorites');
    assert.equal(el(dom, 'favorites-empty').textContent, 'No favorites added from buddies match “nick”.');

    filter('manual').click();
    assert.equal(el(dom, 'favorites-count').textContent, '1 of 3 favorites');
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Nick McMillen']);
    search.value = '';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Kríshna Dase, KD', 'Nick McMillen']);
});

test('Refresh now stores the signed-in owner Buddy List cache', async () => {
    const requests = [];
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => {
            const respond = peakbaggerFetch();
            window.fetch = url => {
                requests.push(String(url));
                return respond(url);
            };
        },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => dom.chrome._localStore[buddyCacheKey]?.entries?.length === 6);
    assert.equal(dom.chrome._localStore[buddyCacheKey].ownerCid, 900001);
    assert.match(el(dom, 'favorites-buddy-status').textContent, /6 buddies · updated just now/);
    assert.deepEqual(requests, ['https://www.peakbagger.com/report/report.aspx?r=b']);
});

test('failed Buddy refresh links to the Buddy List instead of the home page', async () => {
    const requests = [];
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => {
            window.fetch = async url => {
                requests.push(String(url));
                return pageResponse('', 500);
            };
        },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /temporarily unavailable \(HTTP 500\)/.test(el(dom, 'favorites-buddy-status').textContent));
    const recovery = el(dom, 'favorites-buddy-status').querySelector('a');
    assert.deepEqual(requests, ['https://www.peakbagger.com/report/report.aspx?r=b']);
    assert.equal(recovery.textContent, 'Open Buddy List');
    assert.equal(recovery.href, 'https://www.peakbagger.com/report/report.aspx?r=b');
});

test('Buddy refresh distinguishes Cloudflare, network, and parser failures', async () => {
    const cases = [
        {
            response: async () => pageResponse('<html><title>Just a moment...</title></html>', 403),
            expected: /asking for a human check/i,
            action: 'Complete check on Peakbagger',
        },
        {
            response: async () => { throw new TypeError('Failed to fetch'); },
            expected: /could not reach Peakbagger/i,
            action: 'Open Buddy List',
        },
    ];
    for (const item of cases) {
        const dom = await loadFavoritesPage({}, {
            prepareWindow: window => { window.fetch = item.response; },
        });
        el(dom, 'favorites-refresh-buddies').click();
        await waitFor(dom, () => item.expected.test(el(dom, 'favorites-buddy-status').textContent));
        assert.equal(el(dom, 'favorites-buddy-status').querySelector('a').textContent, item.action);
        assert.equal(dom.chrome._localStore[buddyCacheKey], undefined);
    }

    const parserDom = await loadFavoritesPage({}, {
        prepareWindow: window => {
            window.fetch = peakbaggerFetch();
            Object.defineProperty(window, 'DOMParser', {
                configurable: true,
                value: class { parseFromString() { throw new Error('broken parser'); } },
            });
        },
    });
    el(parserDom, 'favorites-refresh-buddies').click();
    await waitFor(parserDom, () => /could not parse the Buddy List/i.test(
        el(parserDom, 'favorites-buddy-status').textContent
    ));
    assert.equal(parserDom.chrome._localStore[buddyCacheKey], undefined);
});

test('an unavailable Buddy worker reports reload guidance without fetching or importing prematurely', async () => {
    for (const phase of ['begin', 'publish']) {
        for (const reply of [null, { ok: true }, 'transport-error']) {
            let fetches = 0;
            const originalCache = { ...buddyCacheFrom(), fetchedAt: 1 };
            const originalFavorites = favoriteStore([{ cid: 900099, name: 'Manual Favorite', addedAt: 1, source: 'manual' }]);
            const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
                local: { [buddyCacheKey]: originalCache, [favoriteKey]: originalFavorites },
                prepareChrome: chrome => {
                    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
                    Object.defineProperty(chrome.runtime, 'sendMessage', { configurable: true, value: async message => {
                        if (message?.type === 'BUDDY_CACHE_UPDATE' && message.phase === phase) {
                            if (reply === 'transport-error') throw new Error('Could not establish connection. Receiving end does not exist.');
                            return reply;
                        }
                        return send(message);
                    } });
                },
                prepareWindow: window => {
                    const fetchBuddies = peakbaggerFetch();
                    window.fetch = (...args) => { fetches++; return fetchBuddies(...args); };
                },
            });
            el(dom, 'favorites-merge-buddies').click();
            await waitFor(dom, () => !el(dom, 'favorites-merge-buddies').disabled);
            assert.match(el(dom, 'favorites-import-status').textContent, /Reload the extension, then reload this page/i,
                `${phase}: ${JSON.stringify(reply)}`);
            assert.doesNotMatch(el(dom, 'favorites-import-status').textContent, /loaded|could not save|reach Peakbagger/i);
            assert.equal(el(dom, 'favorites-import-status').querySelector('a'), null);
            assert.equal(fetches, phase === 'begin' ? 0 : 1);
            assert.deepEqual(dom.chrome._localStore[buddyCacheKey], originalCache);
            assert.deepEqual(dom.chrome._localStore[favoriteKey], originalFavorites);
            assert.equal(dom.chrome._favoriteMutations.length, 0);
        }
    }
});

test('a failed initial Buddy cache read does not claim the list loaded', async () => {
    let fetches = 0;
    const dom = await loadFavoritesPage({}, {
        prepareChrome: chrome => {
            const get = chrome.storage.local.get;
            chrome.storage.local.get = keys => Array.isArray(keys) && keys.includes('bpbBuddyCacheEpoch')
                ? Promise.reject(new Error('storage unavailable')) : get(keys);
        },
        prepareWindow: window => { window.fetch = async () => { fetches++; throw new Error('unexpected fetch'); }; },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => !el(dom, 'favorites-refresh-buddies').disabled);
    assert.match(el(dom, 'favorites-buddy-status').textContent, /could not read your saved Buddy List/i);
    assert.doesNotMatch(el(dom, 'favorites-buddy-status').textContent, /loaded|could not save/i);
    assert.equal(el(dom, 'favorites-buddy-status').querySelector('a'), null);
    assert.equal(fetches, 0);
});

test('a Buddy cache write failure is not mislabeled as a Peakbagger request failure', async () => {
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => { window.fetch = peakbaggerFetch(); },
    });
    const originalSet = dom.chrome.storage.local.set;
    dom.chrome.storage.local.set = async patch => {
        if (buddyCacheKey in patch) throw new Error('storage unavailable');
        return originalSet(patch);
    };
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /loaded, but Better Peakbagger could not save it on this device/i.test(
        el(dom, 'favorites-buddy-status').textContent
    ));
    assert.match(el(dom, 'favorites-buddy-status').textContent, /6 buddies/,
        'the fetched list remains usable for this session');
    assert.equal(el(dom, 'favorites-buddy-status').querySelector('a'), null,
        'a local storage failure must not send the user to Peakbagger');
});

test('an options refresh cannot replace a Buddy change confirmed while its report was loading', async () => {
    let release;
    const dom = await loadFavoritesPage({ favoritesSource: 'buddies' }, {
        prepareWindow: window => { window.fetch = () => new Promise(resolve => { release = resolve; }); },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => release);
    const send = message => dom.chrome.runtime.sendMessage({ type: 'CLIMBER_BUDDY_ACTION', ...message });
    const lease = await send({ phase: 'begin', ownerCid: 900001, cid: 900002, name: 'Confirmed Buddy', action: 'add' });
    await send({ phase: 'dispatch', token: lease.token });
    await send({ phase: 'complete', token: lease.token, buddy: true });
    const confirmed = structuredClone(dom.chrome._localStore[buddyCacheKey]);
    release(pageResponse('<div>Logged in: Test | <a href="https://www.peakbagger.com/climber/climber.aspx?cid=900001">My Home Page</a></div>'
        + '<h1>Buddy List</h1><table id="RGridView"><tr><th>Climber</th></tr></table>'));
    await waitFor(dom, () => !el(dom, 'favorites-refresh-buddies').disabled
        && /1 buddy.*changed during refresh/.test(el(dom, 'favorites-buddy-status').textContent));
    assert.deepEqual(dom.chrome._localStore[buddyCacheKey], confirmed);
    assert.match(el(dom, 'favorites-buddy-status').textContent, /1 buddy.*changed during refresh/);
});

test('Buddy refresh fails closed when the report has no signed-in owner identity', async () => {
    const signedOutReport = buddyPageFixture.replace('>My Home Page<', '>Public profile<');
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => {
            window.fetch = async () => pageResponse(signedOutReport);
        },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /Sign in to Peakbagger/.test(el(dom, 'favorites-buddy-status').textContent));
    const recovery = el(dom, 'favorites-buddy-status').querySelector('a');
    assert.equal(dom.chrome._localStore[buddyCacheKey], undefined);
    assert.equal(recovery.textContent, 'Sign in to Peakbagger');
    assert.equal(recovery.href, 'https://www.peakbagger.com/Default.aspx');
});

test('merge is additive while mirror requires destructive confirmation and supports Undo', async () => {
    const manual = { cid: 900099, name: 'Manual Favorite', addedAt: 1, source: 'manual' };
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore([manual]) },
        prepareWindow: window => { window.fetch = peakbaggerFetch(); },
    });
    await waitFor(dom, () => favoriteRow(dom, manual.cid));

    el(dom, 'favorites-merge-buddies').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.length === 7);
    assert.equal(dom.chrome._favoriteMutations.at(-1).kind, 'merge-buddies');
    assert.equal(dom.chrome._favoriteMutations.at(-1).entries.length, 6);
    assert.equal(el(dom, 'favorites-import-status').textContent,
        'Merge complete: 6 added, 0 removed. Custom list now has 7 climbers.');
    assert.equal(dom.chrome._localStore[favoriteKey].entries[0].cid, manual.cid,
        'merge preserves the existing manual entry and its metadata');

    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === false);
    assert.ok(el(dom, 'favorites-mirror-confirmation').closest('#favorites-custom-panel'),
        'the mirror confirmation stays beside the Mirror control');
    assert.equal(dom.chrome._localStore[favoriteKey].entries.length, 7,
        'loading the mirror preview must not mutate favorites');
    assert.equal(dom.chrome._localStore[favoriteKey].entries.some(entry => entry.cid === manual.cid), true);
    assert.match(el(dom, 'favorites-mirror-confirmation-detail').textContent,
        /0 buddies will be added\. 1 custom favorite will be removed\./);
    assert.match(el(dom, 'favorites-mirror-confirmation-detail').textContent,
        /exactly match your 6 current buddies/);
    assert.match(el(dom, 'favorites-mirror-confirmation-detail').textContent, /undo for 6 seconds/);
    assert.equal(el(dom, 'favorites-mirror-confirm').textContent, 'Replace custom list');
    assert.equal(dom.window.document.activeElement, el(dom, 'favorites-mirror-cancel'));

    el(dom, 'favorites-mirror-cancel').click();
    assert.equal(el(dom, 'favorites-mirror-confirmation').hidden, true);
    assert.equal(dom.chrome._localStore[favoriteKey].entries.some(entry => entry.cid === manual.cid), true,
        'cancelling the confirmation must leave favorites untouched');

    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === false);
    el(dom, 'favorites-mirror-confirm').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey].entries.length === 6
        && !dom.chrome._localStore[favoriteKey].entries.some(entry => entry.cid === manual.cid)
        && /Mirror complete/.test(el(dom, 'favorites-import-status').textContent));
    assert.equal(el(dom, 'favorites-import-status').textContent,
        'Mirror complete: 0 added, 1 removed. Custom list now has 6 climbers.');
    assert.equal(el(dom, 'favorites-undo-all').hidden, false);
    assert.match(el(dom, 'favorites-undo-message').textContent, /replaced with your Buddy List/);

    el(dom, 'favorites-undo-all-button').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey].entries.length === 7
        && dom.chrome._localStore[favoriteKey].entries.some(entry => entry.cid === manual.cid));
});

test('a failed Buddy mirror keeps its reviewed replacement visible and retryable', async () => {
    const manual = { cid: 900099, name: 'Manual Favorite', addedAt: 1, source: 'manual' };
    let buddyLoads = 0;
    let rejectFirstWrite;
    let favoriteWriteAttempts = 0;
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore([manual]) },
        prepareChrome: chrome => {
            const nativeSet = chrome.storage.local.set;
            chrome.storage.local.set = patch => {
                if (!(favoriteKey in patch) || favoriteWriteAttempts++ > 0) return nativeSet(patch);
                return new Promise((resolve, reject) => { rejectFirstWrite = reject; });
            };
        },
        prepareWindow: window => {
            const fetchBuddyList = peakbaggerFetch();
            window.fetch = (...args) => {
                buddyLoads++;
                return fetchBuddyList(...args);
            };
        },
    });
    await waitFor(dom, () => favoriteRow(dom, manual.cid));

    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === false);
    const reviewedImpact = el(dom, 'favorites-mirror-confirmation-detail').textContent;
    el(dom, 'favorites-mirror-confirm').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').getAttribute('aria-busy') === 'true');
    await waitFor(dom, () => typeof rejectFirstWrite === 'function');

    assert.equal(dom.window.document.activeElement, el(dom, 'favorites-mirror-confirmation'));
    assert.equal(el(dom, 'favorites-mirror-confirm').disabled, true);
    assert.equal(el(dom, 'favorites-mirror-cancel').disabled, true);
    assert.equal(dom.window.document.querySelector('input[name="favorites-source"]:not(:disabled)'), null);
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
    }));
    el(dom, 'favorites-mirror-cancel').dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
    }));
    assert.equal(el(dom, 'favorites-mirror-confirmation').hidden, false);
    assert.equal(el(dom, 'favorites-mirror-confirmation-detail').textContent, reviewedImpact);

    rejectFirstWrite(new Error('storage unavailable'));
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').getAttribute('aria-busy') === null
        && dom.window.document.activeElement === el(dom, 'favorites-mirror-confirm'));
    assert.equal(el(dom, 'favorites-mirror-confirmation').hidden, false);
    assert.equal(el(dom, 'favorites-mirror-confirm').disabled, false);
    assert.equal(el(dom, 'favorites-mirror-cancel').disabled, false);
    assert.equal(dom.window.document.querySelectorAll('input[name="favorites-source"]:not(:disabled)').length, 2);
    assert.equal(el(dom, 'favorites-mirror-confirmation-detail').textContent, reviewedImpact);
    assert.equal(buddyLoads, 1);

    el(dom, 'favorites-mirror-confirm').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === true
        && dom.chrome._localStore[favoriteKey].entries.length === 6);
    assert.equal(buddyLoads, 1, 'retrying must reuse the reviewed Buddy replacement');
    assert.equal(favoriteWriteAttempts, 2);
});

test('mirror reports additions and zero removals before and after replacement', async () => {
    const existingBuddy = { cid: 710195, name: 'Existing Buddy', addedAt: 1, source: 'manual' };
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore([existingBuddy]) },
        prepareWindow: window => { window.fetch = peakbaggerFetch(); },
    });
    await waitFor(dom, () => favoriteRow(dom, existingBuddy.cid));

    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === false);
    assert.match(el(dom, 'favorites-mirror-confirmation-detail').textContent,
        /5 buddies will be added\. 0 custom favorites will be removed\./);
    assert.match(el(dom, 'favorites-mirror-confirmation-detail').textContent,
        /exactly match your 6 current buddies/);

    el(dom, 'favorites-mirror-confirm').click();
    await waitFor(dom, () => /Mirror complete/.test(el(dom, 'favorites-import-status').textContent));
    assert.equal(el(dom, 'favorites-import-status').textContent,
        'Mirror complete: 5 added, 0 removed. Custom list now has 6 climbers.');

    el(dom, 'favorites-merge-buddies').click();
    await waitFor(dom, () => /Merge complete/.test(el(dom, 'favorites-import-status').textContent));
    assert.equal(el(dom, 'favorites-import-status').textContent,
        'Merge complete: 0 added, 0 removed. Custom list now has 6 climbers.');
});

test('a stale replacement preserves the prior Undo expiry and the concurrent edit', async () => {
    const manual = { cid: 900099, name: 'Manual Favorite', addedAt: 1, source: 'manual' };
    const concurrent = { cid: 900100, name: 'Other Tab Favorite', addedAt: 2, source: 'manual' };
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore([manual]) },
        prepareWindow: window => {
            window.fetch = peakbaggerFetch();
            const nativeSetTimeout = window.setTimeout.bind(window);
            const nativeClearTimeout = window.clearTimeout.bind(window);
            let nextUndoTimer = -1;
            window.undoTimers = [];
            window.setTimeout = (callback, delay = 0, ...args) => {
                if (delay !== 6000) return nativeSetTimeout(callback, delay, ...args);
                const timer = { id: nextUndoTimer--, callback, cleared: false };
                window.undoTimers.push(timer);
                return timer.id;
            };
            window.clearTimeout = id => {
                const timer = window.undoTimers.find(candidate => candidate.id === id);
                if (timer) timer.cleared = true;
                else nativeClearTimeout(id);
            };
        },
    });

    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === false);
    el(dom, 'favorites-mirror-confirm').click();
    await waitFor(dom, () => el(dom, 'favorites-undo-all').hidden === false);
    assert.equal(dom.window.undoTimers.length, 1);

    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === false);
    const current = dom.chrome._localStore[favoriteKey];
    await dom.chrome.storage.local.set({
        [favoriteKey]: favoriteStore([...current.entries, concurrent]),
    });
    el(dom, 'favorites-mirror-confirm').click();

    await waitFor(dom, () => /changed in another tab/i.test(el(dom, 'status-error-text').textContent));
    assert.equal(dom.window.undoTimers[0].cleared, false,
        'a rejected replacement must not cancel the prior successful replacement expiry');
    assert.equal(dom.chrome._localStore[favoriteKey].entries.some(entry => entry.cid === concurrent.cid), true);

    dom.window.undoTimers[0].callback();
    assert.equal(el(dom, 'favorites-undo-all').hidden, true);
});

test('merge reports buddies skipped when custom favorites are full', async () => {
    const fullList = Array.from({ length: 1500 }, (_, index) => ({
        cid: index + 1,
        name: `Favorite ${index + 1}`,
        addedAt: 1,
        source: 'manual',
    }));
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore(fullList) },
        prepareWindow: window => { window.fetch = peakbaggerFetch(); },
    });
    await waitFor(dom, () => favoriteRow(dom, 1500));

    el(dom, 'favorites-merge-buddies').click();
    await waitFor(dom, () => /Merge complete/.test(el(dom, 'favorites-import-status').textContent));
    assert.equal(el(dom, 'favorites-import-status').textContent,
        'Merge complete: 0 added, 0 removed. Custom list now has 1500 climbers. '
        + '6 buddies were not added because custom favorites can hold up to 1,500 climbers.');
    assert.equal(dom.chrome._localStore[favoriteKey].entries.length, 1500);
});

test('custom import accepts a valid 200 Buddy report carrying Cloudflare metadata', async () => {
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        prepareWindow: window => {
            window.fetch = async () => ({
                status: 200,
                headers: { 'cf-mitigated': 'challenge' },
                text: async () => `${buddyPageFixture}<script>window._cf_chl_opt={}</script>`,
            });
        },
    });

    el(dom, 'favorites-merge-buddies').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.length === 6);
    assert.match(el(dom, 'favorites-import-status').textContent, /Merge complete: 6 added, 0 removed/);
    assert.doesNotMatch(el(dom, 'favorites-import-status').textContent, /human check/i);
});

test('custom import opens a first-party helper when extension cookies look signed out', async () => {
    const opened = [];
    const updated = [];
    const removed = [];
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        prepareChrome: chrome => {
            chrome.runtime.getURL = path => `chrome-extension://test-extension/${path}`;
            chrome.tabs = {
                create: (details, callback) => {
                    opened.push(structuredClone(details));
                    callback({ id: 77 });
                    setTimeout(() => { void chrome.storage.local.set({
                        [buddyCacheKey]: {
                            ownerCid: 900001,
                            entries: [
                                { cid: 900002, name: 'First Buddy' },
                                { cid: 900003, name: 'Second Buddy' },
                            ],
                            fetchedAt: Date.now(),
                        },
                    }); }, 0);
                },
                update: (tabId, details) => { updated.push({ tabId, details }); },
                remove: (tabId, callback) => {
                    removed.push(tabId);
                    callback();
                },
                sendMessage: (tabId, message, callback) => callback({
                    url: 'https://www.peakbagger.com/report/report.aspx?r=b',
                    cache: chrome._localStore[buddyCacheKey],
                }),
            };
        },
        prepareWindow: window => {
            window.fetch = async () => pageResponse('<a href="/Default.aspx">Log In</a>');
        },
    });

    el(dom, 'favorites-merge-buddies').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.length === 2);
    assert.deepEqual(opened, [{
        url: 'chrome-extension://test-extension/options/buddy-refresh.html',
        active: false,
    }]);
    assert.deepEqual(updated, [], 'the helper must not race a second navigation');
    assert.deepEqual(removed, [77]);
    assert.match(el(dom, 'favorites-import-status').textContent, /Merge complete: 2 added, 0 removed/);
});

test('Buddy fallback starts the packaged helper without racing an initial blank navigation', async () => {
    const created = [], removed = [];
    let cache = null;
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        prepareWindow: window => { window.fetch = signedOutFetch(); },
        prepareChrome: chrome => {
            chrome.runtime.getURL = page => `chrome-extension://test-extension/${page}`;
            chrome.tabs = {
                create(details, callback) {
                    created.push(structuredClone(details));
                    // Model an early helper response before create's callback.
                    // A second update while the original blank is provisional
                    // is deliberately ineffective, matching the failed trace.
                    if (details.url.endsWith('/options/buddy-refresh.html')) cache = buddyCacheFrom();
                    callback({ id: 77, url: details.url });
                },
                update(_id, _details, callback) { callback?.({ id: 77, status: 'loading' }); },
                sendMessage(_id, _message, callback) {
                    callback({ url: 'https://www.peakbagger.com/report/report.aspx?r=b', cache });
                },
                remove(id, callback) { removed.push(id); callback?.(); },
            };
        },
    });
    accelerateTimeout(dom, 8000);
    el(dom, 'favorites-merge-buddies').click();
    await waitFor(dom, () => !/Loading/.test(el(dom, 'favorites-import-status').textContent));
    assert.match(el(dom, 'favorites-import-status').textContent, /Merge complete: 6 added, 0 removed/);
    assert.equal(dom.chrome._localStore[favoriteKey].entries.length, 6);
    assert.deepEqual(created, [{ url: 'chrome-extension://test-extension/options/buddy-refresh.html', active: false }]);
    assert.deepEqual(removed, [77]);
});

test('custom import keeps a failed Buddy refresh visible beside the buttons', async () => {
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        prepareWindow: window => { window.fetch = async () => pageResponse('', 500); },
    });
    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => /temporarily unavailable/.test(el(dom, 'favorites-import-status').textContent));
    assert.equal(el(dom, 'favorites-import-status').hidden, false);
    assert.equal(el(dom, 'favorites-import-status').querySelector('a').textContent, 'Open Buddy List');
    assert.equal(dom.chrome._localStore[favoriteKey], undefined);
});

test('a cookie-blocked Buddy read recovers through the first-party helper tab', async () => {
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => { window.fetch = signedOutFetch(); },
        prepareChrome: siteTabChrome({
            onNavigate: ({ chrome }) => {
                void chrome.storage.local.set({ [buddyCacheKey]: buddyCacheFrom() });
            },
        }),
    });

    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /6 buddies/.test(el(dom, 'favorites-buddy-status').textContent));
    // The first navigation is a packaged document, with no provisional blank
    // followed by a competing update.
    assert.equal(dom.chrome._siteTab.created.length, 1);
    assert.equal(dom.chrome._siteTab.created[0].url, 'chrome-extension://test-extension/options/buddy-refresh.html');
    assert.equal(dom.chrome._siteTab.created[0].active, false);
    assert.deepEqual(dom.chrome._siteTab.removed, [77], 'the helper tab must never be left open');
});

test('a managed-challenge 403 recovers through its own first-party Buddy tab', async () => {
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => { window.fetch = async () => pageResponse(cloudflareBody, 403); },
        prepareChrome: siteTabChrome({ onNavigate: ({ chrome }) => {
            void chrome.storage.local.set({ [buddyCacheKey]: buddyCacheFrom() });
        } }),
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /6 buddies/.test(el(dom, 'favorites-buddy-status').textContent));
    assert.doesNotMatch(el(dom, 'favorites-buddy-status').textContent, /human check/);
    assert.equal(el(dom, 'status-error').hidden, true);
    assert.deepEqual(dom.chrome._siteTab.removed, [77]);
});

test('challenge recovery also supports the Firefox promise-based tab API', async () => {
    const removed = [];
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => {
            window.browser = window.chrome;
            window.fetch = async () => pageResponse(cloudflareBody, 403);
        },
        prepareChrome: chrome => {
            chrome.tabs = {
                query: async () => [],
                create: async details => {
                    assert.equal(details.active, false);
                    await chrome.storage.local.set({ [buddyCacheKey]: buddyCacheFrom() });
                    return { id: 77 };
                },
                sendMessage: async () => ({ url: 'https://www.peakbagger.com/report/report.aspx?r=b', cache: buddyCacheFrom() }),
                remove: async tabId => { removed.push(tabId); },
            };
        },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /6 buddies/.test(el(dom, 'favorites-buddy-status').textContent));
    assert.equal(el(dom, 'status-error').hidden, true);
    assert.deepEqual(removed, [77]);
});

test('challenge recovery keeps the working Buddy List hostname and reads only its helper', async () => {
    const navigations = [], reads = [];
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => { window.fetch = async () => pageResponse(cloudflareBody, 403); },
        prepareChrome: chrome => {
            siteTabChrome({ onNavigate: ({ chrome, details }) => {
                navigations.push(details);
                void chrome.storage.local.set({ [buddyCacheKey]: buddyCacheFrom() });
            } })(chrome);
            chrome.tabs.query = (query, callback) => callback([
                { id: 5, url: 'https://www.peakbagger.com/Peak.aspx?pid=1', active: true },
                { id: 6, url: 'https://peakbagger.com/report/report.aspx?r=b', active: false },
                { id: 7, url: 'https://evil.test/report/report.aspx?r=b', active: true },
            ]);
            chrome.tabs.sendMessage = (tabId, message, callback) => {
                reads.push({ tabId, message: structuredClone(message) });
                callback({ url: 'https://peakbagger.com/report/report.aspx?r=b', cache: buddyCacheFrom() });
            };
        },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /6 buddies/.test(el(dom, 'favorites-buddy-status').textContent));
    assert.equal(navigations[0].url, 'chrome-extension://test-extension/options/buddy-refresh.html#origin=https%3A%2F%2Fpeakbagger.com');
    assert.equal(navigations[0].active, false);
    assert.deepEqual(reads, [{ tabId: 77, message: { type: 'BUDDY_PAGE_READ' } }]);
    assert.deepEqual(dom.chrome._siteTab.removed, [77]);
});

test('an unrelated cache update cannot complete a still-challenged helper tab', async () => {
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => { window.fetch = async () => pageResponse(cloudflareBody, 403); },
        prepareChrome: chrome => {
            siteTabChrome({ onNavigate: ({ chrome }) => {
                void chrome.storage.local.set({ [buddyCacheKey]: buddyCacheFrom() });
            } })(chrome);
            chrome.tabs.sendMessage = (tabId, message, callback) => callback({
                url: 'https://www.peakbagger.com/report/report.aspx?r=b', cache: null,
            });
        },
    });
    accelerateTimeout(dom, 8000);
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /human check/.test(el(dom, 'status-error-text').textContent));
    assert.match(el(dom, 'favorites-buddy-status').textContent, /human check/);
    assert.equal(dom.chrome._localStore[favoriteKey], undefined);
    assert.deepEqual(dom.chrome._siteTab.removed, [77]);
});

test('a helper read from another report cannot complete challenge recovery', async () => {
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => { window.fetch = async () => pageResponse(cloudflareBody, 403); },
        prepareChrome: chrome => {
            siteTabChrome({ onNavigate: ({ chrome }) => {
                void chrome.storage.local.set({ [buddyCacheKey]: buddyCacheFrom() });
            } })(chrome);
            chrome.tabs.sendMessage = (tabId, message, callback) => callback({
                url: 'https://www.peakbagger.com/report/report.aspx?r=b&cid=900002', cache: buddyCacheFrom(),
            });
        },
    });
    accelerateTimeout(dom, 8000);
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /human check/.test(el(dom, 'status-error-text').textContent));
    assert.deepEqual(dom.chrome._siteTab.removed, [77]);
});

test('a newer same-owner Buddy List clears the old challenge warning and banner', async () => {
    const dom = await loadFavoritesPage({}, {
        local: { [buddyCacheKey]: { ...buddyCacheFrom(), fetchedAt: 1 } },
        prepareWindow: window => { window.fetch = async () => pageResponse(cloudflareBody, 403); },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /human check/.test(el(dom, 'status-error-text').textContent));
    await dom.chrome.storage.local.set({ [buddyCacheKey]: buddyCacheFrom() });
    await waitFor(dom, () => !/human check/.test(el(dom, 'favorites-buddy-status').textContent));
    assert.match(el(dom, 'favorites-buddy-status').textContent, /6 buddies · updated just now$/);
    assert.equal(el(dom, 'status-error').hidden, true);
});

test('Buddy recovery leaves a newer unrelated error banner visible', async () => {
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [buddyCacheKey]: { ...buddyCacheFrom(), fetchedAt: 1 } },
        prepareWindow: window => { window.fetch = async () => pageResponse(cloudflareBody, 403); },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /human check/.test(el(dom, 'status-error-text').textContent));
    el(dom, 'favorites-add-input').value = 'invalid';
    el(dom, 'favorites-add-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    const unrelatedError = el(dom, 'status-error-text').textContent;
    assert.match(unrelatedError, /Enter a climber id/);
    await dom.chrome.storage.local.set({ [buddyCacheKey]: buddyCacheFrom() });
    await waitFor(dom, () => !/human check/.test(el(dom, 'favorites-buddy-status').textContent));
    assert.equal(el(dom, 'status-error').hidden, false);
    assert.equal(el(dom, 'status-error-text').textContent, unrelatedError);
});

test('an old or different-owner cache cannot clear the failed refresh warning', async () => {
    const dom = await loadFavoritesPage({}, {
        local: { [buddyCacheKey]: { ...buddyCacheFrom(), fetchedAt: 1 } },
        prepareWindow: window => { window.fetch = async () => pageResponse(cloudflareBody, 403); },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /human check/.test(el(dom, 'status-error-text').textContent));
    await dom.chrome.storage.local.set({ [buddyCacheKey]: { ...buddyCacheFrom(), entries: [], fetchedAt: 1 } });
    await waitFor(dom, () => /^0 buddies/.test(el(dom, 'favorites-buddy-status').textContent));
    assert.match(el(dom, 'favorites-buddy-status').textContent, /human check/);
    await dom.chrome.storage.local.set({ [buddyCacheKey]: { ...buddyCacheFrom(), ownerCid: 900099 } });
    await waitFor(dom, () => /^6 buddies/.test(el(dom, 'favorites-buddy-status').textContent));
    assert.match(el(dom, 'favorites-buddy-status').textContent, /human check/);
    assert.equal(el(dom, 'status-error').hidden, false);
});

test('a recovered Buddy List clears an obsolete import failure without performing the import', async () => {
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [buddyCacheKey]: { ...buddyCacheFrom(), fetchedAt: 1 } },
        prepareWindow: window => { window.fetch = async () => pageResponse(cloudflareBody, 403); },
    });
    el(dom, 'favorites-merge-buddies').click();
    await waitFor(dom, () => /human check/.test(el(dom, 'favorites-import-status').textContent));
    await dom.chrome.storage.local.set({ [buddyCacheKey]: buddyCacheFrom() });
    await waitFor(dom, () => el(dom, 'favorites-import-status').hidden);
    assert.equal(el(dom, 'status-error').hidden, true);
    assert.equal(dom.chrome._favoriteMutations.length, 0);
});

test('a wedged helper tab reports the timeout, never “sign in”', async () => {
    // The signed-out error is the one the direct read produced. Repeating it
    // after the fallback merely ran out of time tells a signed-in user to sign
    // in — wrong, and nothing they can act on.
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => { window.fetch = signedOutFetch(); },
        prepareChrome: siteTabChrome({ onNavigate: () => {} }),
    });
    accelerateTimeout(dom, 8000);

    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => !/Refreshing/.test(el(dom, 'favorites-buddy-status').textContent));
    const status = el(dom, 'favorites-buddy-status').textContent;
    assert.match(status, /took too long to return the Buddy List/i);
    assert.doesNotMatch(status, /sign in/i);
    assert.deepEqual(dom.chrome._siteTab.removed, [77], 'a timed-out helper tab is still closed');
});

test('without a helper tab available the original diagnosis still stands', async () => {
    // Nothing ran, so nothing was learned; the signed-out error is still the
    // best available explanation and must not be replaced by a timeout.
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => { window.fetch = signedOutFetch(); },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => !/Refreshing/.test(el(dom, 'favorites-buddy-status').textContent));
    assert.match(el(dom, 'favorites-buddy-status').textContent, /sign in/i);
});



test('closing Buddy List options keeps confirmation visible and restores focus to the summary', async () => {
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        prepareWindow: window => { window.fetch = peakbaggerFetch(); },
    });
    const disclosure = dom.window.document.querySelector('.favorites-buddy-options');
    assert.equal(disclosure.open, false);
    disclosure.open = true;
    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => !el(dom, 'favorites-mirror-confirmation').hidden);
    disclosure.open = false;
    assert.equal(el(dom, 'favorites-mirror-confirmation').closest('details'), null);
    assert.equal(el(dom, 'favorites-undo-all').closest('details'), null);
    el(dom, 'favorites-mirror-cancel').click();
    assert.equal(dom.window.document.activeElement, disclosure.querySelector('summary'));
});
