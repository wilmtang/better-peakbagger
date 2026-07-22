// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { favoriteClimbers as F } from '../../src/favorites/favorite-climbers.js';

const buddyFixture = await readFile(new URL('../fixtures/pages/report-buddy-list.html', import.meta.url), 'utf8');
const climberFixture = await readFile(new URL('../fixtures/pages/climber-home.html', import.meta.url), 'utf8');

test('cleans favorite storage, dedupes ids, and fails closed on unknown schemas', () => {
    const tooLong = ' X '.repeat(150);
    const cleaned = F.cleanFavorites({
        schemaVersion: 1,
        entries: [
            { cid: '900002', name: tooLong, addedAt: 20, source: 'manual' },
            { cid: 900002, name: 'duplicate', addedAt: 30, source: 'buddy' },
            { cid: -1, name: 'Invalid', addedAt: 1, source: 'manual' },
            { cid: 900003, name: 'Wrong source', addedAt: 1, source: 'import' },
        ],
    });
    assert.equal(cleaned.entries.length, 1);
    assert.equal(cleaned.entries[0].cid, 900002);
    assert.equal(cleaned.entries[0].name.length, F.NAME_LIMIT);
    assert.equal(F.validEntry(cleaned.entries[0]), true);
    assert.deepEqual(F.cleanFavorites({ schemaVersion: 2, entries: cleaned.entries }), {
        schemaVersion: 1, entries: [],
    });
});

test('the custom list keeps exactly the 1,500-entry product bound', () => {
    assert.equal(F.LIMIT, 1500);
    const values = Array.from({ length: F.LIMIT + 1 }, (_, index) => ({
        cid: index + 1,
        name: `Climber ${index + 1}`,
        addedAt: index,
        source: 'manual',
    }));
    const cleaned = F.cleanFavorites({ schemaVersion: F.SCHEMA_VERSION, entries: values });
    assert.equal(cleaned.entries.length, F.LIMIT);
    assert.equal(cleaned.entries.at(-1).cid, F.LIMIT);
});

test('cleans buddy cache and applies the seven-day TTL', () => {
    const now = 20 * 24 * 60 * 60 * 1000;
    const cache = F.cleanBuddyCache({
        ownerCid: '900001',
        entries: [{ cid: '900002', name: ' Test Climber ' }, { cid: 900002, name: 'Duplicate' }],
        fetchedAt: now - F.BUDDY_TTL_MS,
    });
    assert.deepEqual(cache, {
        ownerCid: 900001,
        entries: [{ cid: 900002, name: 'Test Climber' }],
        fetchedAt: now - F.BUDDY_TTL_MS,
    });
    assert.equal(F.isFresh(cache, now), true);
    assert.equal(F.isFresh(cache, now + 1), false);
    assert.equal(F.cleanBuddyCache({ ownerCid: 0, entries: [], fetchedAt: now }), null);
});

test('parses the synthetic Buddy List fixture from the climber column only', () => {
    const dom = new JSDOM(buddyFixture, { url: 'https://peakbagger.com/report/report.aspx?r=b&cid=900001' });
    const entries = F.parseBuddyDocument(dom.window.document);
    assert.equal(entries.length, 6);
    assert.deepEqual(entries[0], { cid: 710483, name: 'Alpine, Casey' });

    dom.window.document.querySelector('#RGridView tr:nth-child(2) td:first-child a').remove();
    assert.equal(F.parseBuddyDocument(dom.window.document).length, 5);
});

test('parses climber ids, builds canonical URLs, and extracts the profile name', () => {
    assert.equal(F.parseClimberInput(' 900002 '), 900002);
    assert.equal(F.parseClimberInput('https://peakbagger.com/climber/climber.aspx?cid=900003'), 900003);
    assert.equal(F.parseClimberInput('https://example.com/climber/climber.aspx?cid=900003'), null);
    assert.equal(F.parseClimberInput('https://peakbagger.com/climber/ClimbListC.aspx?cid=900003'), null);
    assert.equal(F.climberPageUrl(900002), 'https://www.peakbagger.com/climber/climber.aspx?cid=900002');
    assert.equal(F.signedInBuddyListUrl('https://peakbagger.com'), 'https://peakbagger.com/report/report.aspx?r=b');
    assert.equal(F.buddyListUrl(900001, 'https://peakbagger.com'), 'https://peakbagger.com/report/report.aspx?r=b&cid=900001');

    const dom = new JSDOM(climberFixture, { url: F.climberPageUrl(900001) });
    assert.equal(F.climberNameFromDocument(dom.window.document), 'Alex Doe');
});

test('merge is additive while mirror replaces and marks buddy entries', () => {
    const favorites = {
        schemaVersion: 1,
        entries: [{ cid: 900002, name: 'Manual Name', addedAt: 10, source: 'manual' }],
    };
    const buddies = [
        { cid: 900002, name: 'Buddy Name' },
        { cid: 900003, name: 'Third Climber' },
    ];
    assert.deepEqual(F.mergeBuddies(favorites, buddies, 20).entries, [
        { cid: 900002, name: 'Manual Name', addedAt: 10, source: 'manual' },
        { cid: 900003, name: 'Third Climber', addedAt: 20, source: 'buddy' },
    ]);
    assert.deepEqual(F.mirrorBuddies(buddies, 30).entries, [
        { cid: 900002, name: 'Buddy Name', addedAt: 30, source: 'buddy' },
        { cid: 900003, name: 'Third Climber', addedAt: 30, source: 'buddy' },
    ]);
});

test('effective sets follow the selected source and comparators are stable', () => {
    const favorites = {
        schemaVersion: 1,
        entries: [
            { cid: 900003, name: 'Zulu', addedAt: 10, source: 'manual' },
            { cid: 900002, name: 'alpha', addedAt: 20, source: 'manual' },
        ],
    };
    const buddyCache = { ownerCid: 900001, entries: [{ cid: 900004, name: 'Buddy' }], fetchedAt: 1 };
    assert.deepEqual([...F.favoriteSet('custom', favorites, buddyCache)], [900003, 900002]);
    assert.deepEqual([...F.favoriteSet('buddies', favorites, buddyCache)], [900004]);
    assert.deepEqual(favorites.entries.slice().sort(F.byName).map(entry => entry.cid), [900002, 900003]);
    assert.deepEqual(favorites.entries.slice().sort(F.byAddedAtDesc).map(entry => entry.cid), [900002, 900003]);
});
