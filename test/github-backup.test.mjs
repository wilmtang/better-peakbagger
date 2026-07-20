// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The GitHub ascent-backup payload builder is pure: one save-time snapshot in,
// one backup folder's files out. These tests pin the folder-slug rules
// (including partial and undated dates and long/non-Latin peak names), the
// ascent.json v1 serialization with unit coercion and blank-field omission,
// the report.md Markdown selection (exact sidecar vs bracket conversion), the
// rename-move detection, and the commit-message text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { githubBackup as Backup } from '../src/github-backup.js';

// github-backup is browser-API-free: the report body arrives already resolved
// to Markdown (the bracket→Markdown conversion runs in the content script,
// where a DOM exists), so this suite needs no DOMParser or marked.

const baseSnapshot = () => ({
    ascent: {
        id: 1234567,
        date: '2026-07-12',
        suffix: '',
        type: 'successful-summit',
        route: 'Disappointment Cleaver',
        routeDown: 'Emmons Glacier',
        externalUrl: 'https://example.com/trip',
        gainFt: '9000', lossFt: '9000',
        distanceUpMi: '8.0', distanceDnMi: '8.0',
        extraGainFt: '300', extraLossFt: '300',
        timeUp: '7:30', timeDn: '4:15', nightsOut: '1',
        startFt: '5400', endFt: '5400', pointFt: '14411',
        quality: '9',
        gear: ['Ice Axe', 'Crampons'],
        companions: { registered: [{ id: 42, name: 'Ada' }], others: 'Rope team' },
        weather: { precip: 'None', temperature: 'Cold', wind: 'Breezy', visibility: 'Clear', description: 'Clouds lifted' },
    },
    peak: { id: 2296, name: 'Mount Rainier', elevationFt: '14411', location: 'Washington, USA' },
    report: { markdown: '**Great climb**' },
    backup: { extensionVersion: '2.2.0', syncedAt: '2026-07-12T21:04:05Z' },
});

// ---- folder slug ----------------------------------------------------------

test('folder name is date-first with a stable a<ascentId> suffix', () => {
    assert.equal(Backup.folderName(baseSnapshot()), '2026-07-12-mount-rainier-a1234567');
    assert.equal(Backup.folderPath(baseSnapshot()), 'ascents/2026-07-12-mount-rainier-a1234567');
});

test('partial and undated dates degrade gracefully in the folder name', () => {
    const monthOnly = baseSnapshot(); monthOnly.ascent.date = '2026-07-00';
    assert.equal(Backup.folderName(monthOnly), '2026-07-mount-rainier-a1234567');

    const yearOnly = baseSnapshot(); yearOnly.ascent.date = '2026-00-00';
    assert.equal(Backup.folderName(yearOnly), '2026-mount-rainier-a1234567');

    const undated = baseSnapshot(); undated.ascent.date = '';
    assert.equal(Backup.folderName(undated), 'undated-mount-rainier-a1234567');

    const missing = baseSnapshot(); missing.ascent.date = null;
    assert.equal(Backup.folderName(missing), 'undated-mount-rainier-a1234567');
});

test('peak slug strips diacritics, collapses punctuation, and caps length', () => {
    assert.equal(Backup.peakSlug('Cerro Torre'), 'cerro-torre');
    assert.equal(Backup.peakSlug('Piz Bernina (Biancograt)'), 'piz-bernina-biancograt');
    assert.equal(Backup.peakSlug('Núria'), 'nuria');
    assert.equal(Backup.peakSlug('   ---   '), 'peak');
    assert.equal(Backup.peakSlug('日本語'), 'peak');
    assert.ok(Backup.peakSlug('a'.repeat(200)).length <= 60);
});

// ---- rename / re-sync detection -------------------------------------------

test('matchExistingFolder finds the ascent folder regardless of slug and never partial-matches the id', () => {
    const names = ['2026-07-11-mount-baker-a999', '2026-06-01-mount-rainier-a1234567'];
    assert.equal(Backup.matchExistingFolder(names, 1234567), '2026-06-01-mount-rainier-a1234567');
    // 123 must not match a folder ending in a1234567.
    assert.equal(Backup.matchExistingFolder(names, 123), null);
    assert.equal(Backup.matchExistingFolder([], 1234567), null);
});

test('buildBackup flags a rename and names the old folder for atomic removal', () => {
    const snap = baseSnapshot();
    const existingFolders = ['2026-06-01-mount-rainier-a1234567'];
    const backup = Backup.buildBackup(snap, { existingFolders, gpx: '<gpx/>' });
    assert.equal(backup.isUpdate, true);
    assert.equal(backup.folder, 'ascents/2026-07-12-mount-rainier-a1234567');
    assert.equal(backup.previousFolder, 'ascents/2026-06-01-mount-rainier-a1234567');
    assert.equal(backup.message, 'Update ascent: Mount Rainier, 2026-07-12');
    assert.deepEqual(backup.files.map(f => f.path), [
        'ascents/2026-07-12-mount-rainier-a1234567/report.md',
        'ascents/2026-07-12-mount-rainier-a1234567/ascent.json',
        'ascents/2026-07-12-mount-rainier-a1234567/track.gpx',
    ]);
});

test('buildBackup with no existing folder is an Add and has no previousFolder', () => {
    const backup = Backup.buildBackup(baseSnapshot(), { existingFolders: [] });
    assert.equal(backup.isUpdate, false);
    assert.equal(backup.previousFolder, null);
    assert.equal(backup.message, 'Add ascent: Mount Rainier, 2026-07-12');
});

test('an unchanged slug re-sync updates in place with no removal', () => {
    const backup = Backup.buildBackup(baseSnapshot(), {
        existingFolders: ['2026-07-12-mount-rainier-a1234567'],
    });
    assert.equal(backup.isUpdate, true);
    assert.equal(backup.previousFolder, null);
});

// ---- ascent.json ----------------------------------------------------------

test('ascent.json coerces units and carries identity, peak, and provenance', () => {
    const json = Backup.buildAscentJson(baseSnapshot());
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.ascent.id, 1234567);
    assert.equal(json.ascent.url, 'https://peakbagger.com/climber/ascent.aspx?aid=1234567');
    assert.equal(json.ascent.date, '2026-07-12');
    assert.equal(json.ascent.gainFt, 9000);        // "9000" → 9000
    assert.equal(json.ascent.distanceUpMi, 8);      // "8.0" → 8
    assert.equal(json.ascent.quality, 9);
    assert.equal(json.ascent.routeDown, 'Emmons Glacier');
    assert.equal(json.ascent.externalUrl, 'https://example.com/trip');
    assert.deepEqual(json.ascent.gear, ['Ice Axe', 'Crampons']);
    assert.deepEqual(json.ascent.companions, { registered: [{ name: 'Ada', id: 42 }], others: 'Rope team' });
    assert.deepEqual(json.ascent.weather, {
        precip: 'None', temperature: 'Cold', wind: 'Breezy', visibility: 'Clear', description: 'Clouds lifted',
    });
    assert.deepEqual(json.peak, {
        id: 2296,
        url: 'https://peakbagger.com/peak.aspx?pid=2296',
        name: 'Mount Rainier',
        elevationFt: 14411,
        location: 'Washington, USA',
    });
    assert.deepEqual(json.backup, { syncedAt: '2026-07-12T21:04:05Z', extensionVersion: '2.2.0' });
});

test('blank and unparseable fields are omitted, never invented', () => {
    const snap = baseSnapshot();
    snap.ascent.route = '   ';
    snap.ascent.gainFt = '';
    snap.ascent.lossFt = 'n/a';
    snap.ascent.extraGainFt = '0';   // a real zero is kept
    snap.ascent.gear = [];
    snap.ascent.companions = { registered: [], others: '' };
    snap.ascent.weather = { precip: '', temperature: '' };
    const json = Backup.buildAscentJson(snap);
    assert.ok(!('route' in json.ascent));
    assert.ok(!('gainFt' in json.ascent));
    assert.ok(!('lossFt' in json.ascent));
    assert.equal(json.ascent.extraGainFt, 0);
    assert.ok(!('gear' in json.ascent));
    assert.ok(!('companions' in json.ascent));
    assert.ok(!('weather' in json.ascent));
    // suffix stays present as a string even when empty.
    assert.equal(json.ascent.suffix, '');
});

test('weather labels are serialized as entered and blank weather is omitted', () => {
    const snap = baseSnapshot();
    snap.ascent.weather = { precip: '', temperature: 'Frigid' };
    assert.deepEqual(Backup.buildAscentJson(snap).ascent.weather, { temperature: 'Frigid' });

    const descriptionOnly = baseSnapshot();
    descriptionOnly.ascent.weather = { description: 'Changing conditions' };
    assert.deepEqual(Backup.buildAscentJson(descriptionOnly).ascent.weather, { description: 'Changing conditions' });
});

test('a partial date serializes to the known components and undated to null', () => {
    const monthOnly = baseSnapshot(); monthOnly.ascent.date = '2026-07-00';
    assert.equal(Backup.buildAscentJson(monthOnly).ascent.date, '2026-07');
    const undated = baseSnapshot(); undated.ascent.date = '';
    assert.equal(Backup.buildAscentJson(undated).ascent.date, null);
});

// ---- report.md ------------------------------------------------------------

test('report.md wraps the resolved Markdown body verbatim under self-describing frontmatter', () => {
    const snap = baseSnapshot();
    snap.report = { markdown: 'We climbed **Baker** under blue skies.\n\n- ice axe\n- crampons' };
    const md = Backup.buildReportMarkdown(snap);
    assert.ok(md.startsWith('---\n'));
    assert.ok(md.includes('peak: "Mount Rainier"'));
    assert.ok(md.includes('date: 2026-07-12'));
    assert.ok(md.includes('peakbagger: https://peakbagger.com/climber/ascent.aspx?aid=1234567'));
    // Verbatim body, including the user's exact list markers and emphasis.
    assert.ok(md.includes('We climbed **Baker** under blue skies.\n\n- ice axe\n- crampons'));
    assert.ok(md.endsWith('\n'));
});

test('report.md tolerates a missing body (frontmatter only)', () => {
    const snap = baseSnapshot();
    snap.report = { markdown: '' };
    const md = Backup.buildReportMarkdown(snap);
    assert.ok(md.startsWith('---\n'));
    assert.ok(md.includes('peakbagger: https://peakbagger.com/climber/ascent.aspx?aid=1234567'));
    // Frontmatter only: the closing fence is the last content line.
    assert.equal(md.trimEnd().split('\n').pop(), '---');
});

test('a colon in the peak name is safely quoted in the frontmatter', () => {
    const snap = baseSnapshot();
    snap.peak.name = 'Peak: The Sequel';
    const md = Backup.buildReportMarkdown(snap);
    assert.ok(md.includes('peak: "Peak: The Sequel"'));
});

// ---- files ----------------------------------------------------------------

test('track.gpx is omitted when no track exists and included when it does', () => {
    const withGpx = Backup.buildFiles(baseSnapshot(), { gpx: '<gpx></gpx>' });
    assert.deepEqual(withGpx.map(f => f.name), ['report.md', 'ascent.json', 'track.gpx']);

    const withoutGpx = Backup.buildFiles(baseSnapshot(), {});
    assert.deepEqual(withoutGpx.map(f => f.name), ['report.md', 'ascent.json']);

    const blankGpx = Backup.buildFiles(baseSnapshot(), { gpx: '   ' });
    assert.deepEqual(blankGpx.map(f => f.name), ['report.md', 'ascent.json']);
});

test('ascent.json file content is pretty-printed and newline-terminated', () => {
    const [, json] = Backup.buildFiles(baseSnapshot(), {});
    assert.equal(json.name, 'ascent.json');
    assert.ok(json.content.endsWith('\n'));
    assert.deepEqual(JSON.parse(json.content), Backup.buildAscentJson(baseSnapshot()));
});

// ---- commit subject -------------------------------------------------------

test('commit subject reads as a sentence and drops an unknown date', () => {
    assert.equal(Backup.commitSubject(baseSnapshot(), {}), 'Add ascent: Mount Rainier, 2026-07-12');
    assert.equal(Backup.commitSubject(baseSnapshot(), { update: true }), 'Update ascent: Mount Rainier, 2026-07-12');

    const undated = baseSnapshot(); undated.ascent.date = '';
    assert.equal(Backup.commitSubject(undated, {}), 'Add ascent: Mount Rainier');
});
