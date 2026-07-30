import test from 'node:test';
import assert from 'node:assert/strict';
import {
    loadFavoritesPage, el, favoriteRow, waitFor, registerCleanup,
    accelerateTimeout, siteTabChrome, buddyCacheFrom, signedOutFetch,
    favoriteKey, buddyCacheKey, favoriteStore, peakbaggerFetch, pageResponse, buddyPageFixture
} from '../helpers/options-helpers.mjs';

registerCleanup();

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
                },
                update: (tabId, details, callback) => {
                    updated.push({ tabId, details: structuredClone(details) });
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
                    callback({ id: tabId, ...details });
                },
                remove: (tabId, callback) => {
                    removed.push(tabId);
                    callback();
                },
            };
        },
        prepareWindow: window => {
            window.fetch = async () => pageResponse('<a href="/Default.aspx">Log In</a>');
        },
    });

    el(dom, 'favorites-merge-buddies').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.length === 2);
    assert.deepEqual(opened, [{
        url: 'about:blank',
        active: false,
    }]);
    assert.deepEqual(updated, [{
        tabId: 77,
        details: {
            url: 'chrome-extension://test-extension/options/buddy-refresh.html',
            active: false,
        },
    }]);
    assert.deepEqual(removed, [77]);
    assert.match(el(dom, 'favorites-import-status').textContent, /Merge complete: 2 added, 0 removed/);
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
    // Chrome leaves an inactive tab at about:blank when create() gets a URL
    // whose load does not settle, so the blank-then-navigate order matters.
    assert.equal(dom.chrome._siteTab.created.length, 1);
    assert.equal(dom.chrome._siteTab.created[0].url, 'about:blank');
    assert.equal(dom.chrome._siteTab.created[0].active, false);
    assert.deepEqual(dom.chrome._siteTab.removed, [77], 'the helper tab must never be left open');
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

