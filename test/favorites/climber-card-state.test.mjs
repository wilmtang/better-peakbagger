// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { climberCardTarget, climberCardState } from '../../src/favorites/climber-card-state.js';

const cid = 900002, ownerCid = 900001;
const entry = { cid, name: 'Casey Alpine', addedAt: 1, source: 'manual' };
const state = (flags = {}, overrides = {}) => climberCardState({ cid, ownerCid,
    settings: { favoritesSource: 'custom' }, membership: {
        favorites: { entries: flags.favorite ? [entry] : [] },
        ignored: { entries: flags.ignored ? [entry] : [] },
        buddies: { ownerCid, entries: flags.buddy ? [entry] : [] },
        pendingIds: new Set(flags.pending ? [cid] : []), error: '',
    }, ...overrides });

test('active, expired and confirmed intents all protect Ignore but only active work disables checking', () => {
    const membership = { favorites: { entries: [] }, ignored: { entries: [] }, pendingIds: new Set(), error: '',
        buddyIntents: [{ cid, status: 'prepared', leaseUntil: Date.now() + 30000 }] };
    const active = state({}, { membership });
    assert.equal(active.buddyInFlight, true); assert.equal(active.ignoreDisabled, true);
    assert.match(active.note, /in progress/);
    membership.buddyIntents[0].leaseUntil = 0;
    assert.equal(state({}, { membership }).buddyInFlight, false);
    assert.equal(state({}, { membership }).ignoreDisabled, true);
    membership.buddyIntents[0].status = 'confirmed';
    assert.equal(state({}, { membership }).ignoreDisabled, true);
    membership.buddyIntents[0].leaseUntil = Date.now() + 30000;
    assert.equal(state({}, { membership }).buddyInFlight, true, 'confirmed-status recovery can still own a live lease');
});

test('card targets accept real profile links and reject ambiguous or non-person links', () => {
    assert.deepEqual(climberCardTarget('Climber.aspx?cid=900002', ' Casey\n Alpine ',
        'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=1'), {
        cid, name: 'Casey Alpine', url: 'https://www.peakbagger.com/climber/climber.aspx?cid=900002',
    });
    for (const href of ['http://www.peakbagger.com/climber/climber.aspx?cid=900002',
        'https://example.com/climber/climber.aspx?cid=900002',
        'https://user:pass@www.peakbagger.com/climber/climber.aspx?cid=900002',
        '/climber/climber.aspx?cid=900002&cid=900003', '/climber/climber.aspx?cid=0',
        '/climber/climber.aspx?cid=9007199254740993', '/climber/ClimbListC.aspx?cid=900002']) {
        assert.equal(climberCardTarget(href, 'Casey Alpine', 'https://www.peakbagger.com/'), null, href);
    }
    for (const label of ['', ' My Home Page ', 'Home Page', ' HOME\n PAGE ', 'Home', 'Profile', 'View profile', 'Climber page']) {
        assert.equal(climberCardTarget('/climber/climber.aspx?cid=900002', label, 'https://www.peakbagger.com/'), null, label);
    }
});

test('card additions preserve membership conflicts in both favorite source modes', () => {
    for (const mode of ['custom', 'buddies']) {
        assert.equal(state({}, { settings: { favoritesSource: mode } }).custom, mode === 'custom');
        for (const flags of [{ favorite: true }, { buddy: true }, { favorite: true, buddy: true }]) {
            const view = state(flags, { settings: { favoritesSource: mode } });
            assert.equal(view.ignoreDisabled, true);
            assert.equal(view.favoriteDisabled, false);
        }
        const ignored = state({ ignored: true }, { settings: { favoritesSource: mode } });
        assert.equal(ignored.buddyBlocked, true);
        assert.equal(ignored.favoriteDisabled, true);
        assert.equal(ignored.ignoreDisabled, false);
    }
    const overlap = state({ favorite: true, buddy: true, ignored: true });
    assert.equal(overlap.favoriteDisabled, false);
    assert.equal(overlap.buddyBlocked, false);
    assert.equal(overlap.ignoreDisabled, false);
});

test('pending sync and unavailable membership cannot become valid empty lists', () => {
    assert.equal(state({ pending: true }).favoriteDisabled, true);
    assert.equal(state({ pending: true }).buddyBlocked, true);
    const empty = state({}, { membership: null });
    assert.equal(empty.favoriteDisabled, true);
    assert.equal(empty.ignoreDisabled, true);
    const failed = state({}, { membership: { error: "Couldn't load climber lists." } });
    assert.equal(failed.favoriteDisabled, true);
    assert.equal(failed.ignoreDisabled, true);
    assert.match(failed.note, /Couldn't load/);
    assert.equal(state({}, { settings: null }).favoriteDisabled, true);
});

test('account-mismatched cache is protected without being presented as a current buddy', () => {
    const view = state({}, { membership: { favorites: { entries: [] }, ignored: { entries: [] },
        buddies: { ownerCid: 900003, entries: [entry] }, pendingIds: new Set(), error: '' } });
    assert.equal(view.buddy, false);
    assert.equal(view.ignoreDisabled, true);
    assert.match(view.ignoreDetail, /previous Peakbagger account/);
    assert.equal(view.savedBuddyOwnerCid, 900003);
    assert.equal(state({ buddy: true }, { ownerCid: null }).buddy, false);
    assert.equal(state({}, { nativeBuddy: true }).ignoreDisabled, true);
    assert.equal(state({}, { buddyPending: true }).ignoreDisabled, true);
});

test('self links, busy actions, and list ceilings retain safe removals', () => {
    assert.equal(state({}, { ownerCid: cid }).self, true);
    assert.equal(state({}, { ownerCid: cid }).favoriteDisabled, true);
    assert.equal(state({}, { busy: true }).ignoreDisabled, true);
    const entries = Array.from({ length: 1500 }, (_, index) => ({ ...entry, cid: index + 1 }));
    const membership = { favorites: { entries }, ignored: { entries }, pendingIds: new Set(), error: '' };
    assert.equal(state({}, { membership }).favoriteDisabled, true);
    assert.equal(state({}, { membership }).ignoreDisabled, true);
    membership.favorites.entries[0] = entry;
    membership.ignored.entries[0] = entry;
    assert.equal(state({}, { membership }).favoriteDisabled, false);
    assert.equal(state({}, { membership }).ignoreDisabled, false);
});
