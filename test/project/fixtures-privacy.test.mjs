// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Guards that no committed fixture (or fixture doc) leaks the identity of the
// account holder whose signed-in session the live captures came from.
//
// The banned identifiers are deliberately not stored in plaintext. The shared
// salted-hash scanner lives in scripts/privacy-guard.mjs and is also used by
// the repository-local pre-commit hook.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { containsFixtureBannedIdentifier } from '../../scripts/privacy-guard.mjs';
import { decideHookInstall, HOOKS_PATH } from '../../scripts/install-git-hooks.mjs';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

// Wayback captures of public peaks (other people's public data) legitimately
// carry external links; every other .html fixture is a masked live capture.
const WAYBACK = new Set([
    '1039-default-full-columns.html',
    '21500-y9998-sort-ascentdated.html',
    '21500-y9999-sort-ascentdate.html',
    '8241-y9999-sort-quality.html'
]);

const MASKED_CLIMBER_ID = '900001';
// The public-climber fixture deliberately represents a second synthetic person
// so the favorite control can prove that it never appears on the owner's page.
const REVIEWED_CLIMBER_IDS = new Map([
    ['climber-other.html', [MASKED_CLIMBER_ID, '900002']],
]);
const SOCIAL = /strava\.com|instagram\.com|facebook\.com|youtube\.com|youtu\.be|mountainproject\.com|flickr\.com|twitter\.com|linkedin\.com|@gmail\.|@outlook\.|@yahoo\./i;

const walk = async dir => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await walk(full));
        else if (/\.(html|md)$/.test(entry.name)) out.push(full);
    }
    return out;
};

const liveCaptures = files =>
    files.filter(f => f.endsWith('.html') && !WAYBACK.has(path.basename(f)));

test('no fixture or fixture doc contains a banned identifier', async () => {
    const files = await walk(FIXTURES);
    assert.ok(files.filter(f => f.endsWith('.html')).length >= 11, 'expected the fixture set to be present');

    const leaks = [];
    for (const file of files) {
        const text = await readFile(file, 'utf8');
        if (containsFixtureBannedIdentifier(text)) {
            leaks.push(path.relative(FIXTURES, file));
        }
    }
    assert.deepEqual(leaks, [], `PII found in fixtures:\n${leaks.join('\n')}`);
});

test('masked live captures carry no external social/identity links', async () => {
    const hits = [];
    for (const file of liveCaptures(await walk(FIXTURES))) {
        const match = (await readFile(file, 'utf8')).match(SOCIAL);
        if (match) hits.push(`${path.relative(FIXTURES, file)}: ${match[0]}`);
    }
    assert.deepEqual(hits, [], `unmasked external links:\n${hits.join('\n')}`);
});

test('masking actually ran: live captures carry the masked climber id, and only it', async () => {
    const live = liveCaptures(await walk(FIXTURES));
    assert.ok(live.length >= 7, 'expected the live-capture set to be present');

    for (const file of live) {
        const text = await readFile(file, 'utf8');
        assert.match(text, new RegExp(MASKED_CLIMBER_ID),
            `${path.basename(file)} should carry the masked climber id (was this capture masked?)`);
    }

    // Personal pages are entirely synthetic. Most represent only the masked
    // account holder; explicitly reviewed interaction fixtures may include a
    // second synthetic identity.
    const climberPages = live.filter(f => path.basename(f).startsWith('climber-'));
    assert.ok(climberPages.length >= 2, 'expected the personal climber-* pages');
    for (const file of climberPages) {
        const text = await readFile(file, 'utf8');
        const ids = new Set([...text.matchAll(/\b(?:cid|c|d)=(\d+)/g)].map(m => m[1]));
        const expected = REVIEWED_CLIMBER_IDS.get(path.basename(file)) ?? [MASKED_CLIMBER_ID];
        assert.deepEqual([...ids].sort(), [...expected].sort(),
            `${path.basename(file)} references unreviewed climber ids`);
    }
});

test('the Buddy List fixture contains only the reviewed synthetic row data', async () => {
    const html = await readFile(path.join(FIXTURES, 'pages', 'report-buddy-list.html'), 'utf8');
    const document = new JSDOM(html).window.document;
    const rows = [...document.querySelectorAll('#RGridView tr')].slice(1);
    assert.equal(rows.length, 6);

    const values = column => rows.map(row => row.cells[column].textContent.trim());
    assert.deepEqual(values(0), [
        'Alpine, Casey', 'Example, Rowan', 'Fixture, Sol',
        'Mock, Quinn', 'Sample, Juniper', 'Synthetic, Arden'
    ]);
    assert.deepEqual(values(2), [
        '2021-03-14', '2024-11-02', '2019-07-28',
        '2023-01-09', '2020-05-21', '2025-08-30'
    ]);
    assert.deepEqual(values(3), [
        'Granite Point', 'Juniper Dome', 'Echo Ridge',
        'Fiction Peak', 'Northwind Hill', 'Placeholder Butte'
    ]);
    assert.deepEqual(values(5), [
        'Test Range-North', 'Example Basin-West', 'Sample County-East',
        'Mock Range-South', 'Fixture District-Central', 'Synthetic Province-North'
    ]);

    for (const row of rows) {
        assert.match(row.cells[0].querySelector('a').href, /[?&]cid=710\d{3}$/);
        assert.match(row.cells[1].querySelector('a').href, /[?&]cid=710\d{3}&sort=AscentDateD$/);
        assert.match(row.cells[2].querySelector('a').href, /[?&]aid=810\d{3}$/);
        assert.match(row.cells[3].querySelector('a').href, /[?&]pid=610\d{3}$/);
    }
});

// The staged scan above is only half the guard. The other half is that
// .githooks/pre-commit actually runs, which depends on core.hooksPath — a
// setting nothing in the repository used to touch and no document mentioned, so
// it silently worked in one clone and was silently absent everywhere else.
test('the staged privacy scan is wired into every clone, not just a configured one', async () => {
    const repoRoot = path.resolve(FIXTURES, '../..');

    const hook = await readFile(path.join(repoRoot, '.githooks', 'pre-commit'), 'utf8');
    assert.match(hook, /scripts\/privacy-guard\.mjs/,
        'the pre-commit hook must run the shared privacy scanner');

    const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.match(manifest.scripts.prepare ?? '', /install-git-hooks\.mjs/,
        'npm install/ci must point this clone at .githooks');

    // Installing must never break an install, and must never overwrite a
    // hooksPath the user chose for this repository.
    assert.equal(HOOKS_PATH, '.githooks');
    const decide = (configuredPath, insideWorkTree = true) =>
        decideHookInstall({ insideWorkTree, configuredPath, root: repoRoot });

    // A fresh clone. The caller must read the *local* config: `git config
    // --get` falls back to a machine-wide core.hooksPath, and treating that as
    // a decision about this repository would leave exactly the clones this
    // guard is for with no scan at all.
    assert.deepEqual(decide(null), { action: 'install' });
    assert.equal(decide(null, false).action, 'skip',
        'a tarball install or a checkout with no .git is not a failure');

    // Git accepts a relative or an absolute hooksPath; both spellings of this
    // repository's own directory are installed, not foreign.
    assert.equal(decide('.githooks').reason, 'already-installed');
    assert.equal(decide('./.githooks').reason, 'already-installed');
    assert.equal(decide(path.join(repoRoot, '.githooks')).reason, 'already-installed');
    assert.equal(decide('.myhooks').reason, 'foreign-hooks-path');
    assert.equal(decide('/opt/hooks').reason, 'foreign-hooks-path');

    const guide = await readFile(path.join(repoRoot, 'docs', 'development.md'), 'utf8');
    assert.match(guide, /core\.hooksPath/,
        'the development guide must tell a reader the scan exists and how to enable it');
});
