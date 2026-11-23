// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Guards that no committed fixture (or fixture doc) leaks the identity of the
// account holder whose signed-in session the live captures came from.
//
// The banned identifiers are deliberately not stored in plaintext. The shared
// salted-hash scanner lives in scripts/privacy-guard.mts and is also used by
// the repository-local pre-commit hook.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_XML_ELEMENTS, XML_FIXTURES } from '../helpers/fixture-privacy-xml.mts';
import { containsFixtureBannedIdentifier } from '../../scripts/privacy-guard.mts';
import { decideHookInstall, HOOKS_PATH } from '../../scripts/install-git-hooks.mts';
import {
    decodeFixtureForPrivacy,
    FIXTURE_PRIVACY_MANIFEST,
} from '../helpers/fixture-privacy-manifest.mts';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const REPO_ROOT = path.resolve(FIXTURES, '../..');

// Wayback captures of public peaks (other people's public data) legitimately
// carry external links; other HTML fixtures are masked captures or explicitly
// reviewed identity-free challenge responses.
const WAYBACK = new Set([
    '1039-default-full-columns.html',
    '21500-y9998-sort-ascentdated.html',
    '21500-y9999-sort-ascentdate.html',
    '8241-y9999-sort-quality.html',
    // Logged-out Provisional Peak page (pid=-34225); see pages/README.md.
    'peak-provisional.html',
]);

const MASKED_CLIMBER_ID = '900001';
const IDENTITY_FREE_CHALLENGES = new Set([
    'peakbagger-managed-challenge.html',
    'pages/cloudflare-challenge.html',
]);
// The public-climber fixture deliberately represents a second synthetic person
// so the favorite control can prove that it never appears on the owner's page.
const REVIEWED_CLIMBER_IDS = new Map([
    ['climber-other.html', [MASKED_CLIMBER_ID, '900002']],
    ['climber-buddy-form.html', [MASKED_CLIMBER_ID, '900002']],
]);
const SOCIAL = /strava\.com|instagram\.com|facebook\.com|youtube\.com|youtu\.be|mountainproject\.com|flickr\.com|twitter\.com|linkedin\.com|@gmail\.|@outlook\.|@yahoo\./i;

const fixtureFiles = () => execFileSync('git', [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'test/fixtures',
], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map(relative => path.join(REPO_ROOT, relative));

const liveCaptures = (files: string[]) =>
    files.filter(f => f.endsWith('.html') && !WAYBACK.has(path.basename(f)));

test('no fixture or fixture doc contains a banned identifier', async () => {
    const files = fixtureFiles();
    assert.ok(files.filter(f => f.endsWith('.html')).length >= 11, 'expected the fixture set to be present');

    const leaks = [];
    for (const file of files) {
        const relative = path.relative(FIXTURES, file);
        const { text } = decodeFixtureForPrivacy(relative, await readFile(file));
        if (containsFixtureBannedIdentifier(text)) {
            leaks.push(relative);
        }
    }
    assert.deepEqual(leaks, [], `PII found in fixtures:\n${leaks.join('\n')}`);
});

test('every fixture format is registered and encoded XML is structurally sanitized', async () => {
    assert.deepEqual(FIXTURE_PRIVACY_MANIFEST.map(({ suffix, format, decoder }) =>
        ({ suffix, format, decoder })), [
        { suffix: '.gpx.gz.b64', format: 'gpx+xml', decoder: 'base64+gzip+utf8' },
        { suffix: '.html', format: 'html', decoder: 'utf8' },
        { suffix: '.gpx', format: 'gpx+xml', decoder: 'utf8' },
        { suffix: '.xml', format: 'xml', decoder: 'utf8' },
        { suffix: '.md', format: 'markdown', decoder: 'utf8' },
        { suffix: '.json', format: 'json', decoder: 'json+utf8' },
        { suffix: '.svelte', format: 'svelte', decoder: 'utf8' },
        { suffix: '.ts', format: 'typescript', decoder: 'utf8' },
    ]);
    assert.throws(() => decodeFixtureForPrivacy('fixture.zip', Buffer.from('not a fixture')),
        /Unregistered fixture extension/);
    assert.throws(() => decodeFixtureForPrivacy('fixture.gpx.gz.b64', Buffer.from('not base64')),
        /canonical base64/);

    const xmlFixtures = [];
    for (const file of fixtureFiles()) {
        const relative = path.relative(FIXTURES, file);
        const decoded = decodeFixtureForPrivacy(relative, await readFile(file));
        if (decoded.format === 'gpx+xml' || decoded.format === 'xml') {
            xmlFixtures.push({ relative, ...decoded });
        }
    }
    assert.ok(xmlFixtures.some(({ relative }) => relative.endsWith('.gpx.gz.b64')),
        'expected the encoded GPX fixture to be decoded and inspected');

    for (const { relative, text } of xmlFixtures) {
        assert.equal(containsFixtureBannedIdentifier(text), false,
            `${relative} contains a known personal identifier after decoding`);
        // A text-level backstop so npm test still guards a push: the real
        // XML parse in fixtures-privacy.browser.mts is the authoritative check.
        const root = /<(?![?!])[^>]*>/.exec(text)?.[0] ?? '';
        assert.doesNotMatch(root, /\screator\s*=/, `${relative} retains creator metadata`);
        for (const tag of FORBIDDEN_XML_ELEMENTS) {
            assert.doesNotMatch(text, new RegExp(`<(?:[\\w.-]+:)?${tag}[\\s/>]`),
                `${relative} retains forbidden <${tag}> data`);
        }
    }
    // Their structure is checked with a real XML parser in
    // fixtures-privacy.browser.mts, which reads exactly this list.
    assert.deepEqual(xmlFixtures.map(({ relative }) => relative.split(path.sep).join('/')).sort(), [...XML_FIXTURES].sort(),
        'register every XML fixture in test/helpers/fixture-privacy-xml.mts');
});

test('JSON fixtures are validated and decoded before their text is privacy-scanned', () => {
    const decoded = decodeFixtureForPrivacy('synthetic.json',
        Buffer.from('{"\\u006eame":"fixture\\u002dperson","nested":{"id":"710001"}}'));
    assert.equal(decoded.format, 'json');
    assert.match(decoded.text, /"name":"fixture-person"/);
    assert.match(decoded.text, /"id":"710001"/);
    assert.throws(() => decodeFixtureForPrivacy('invalid.json', Buffer.from('{"name":}')), SyntaxError);
    assert.throws(() => decodeFixtureForPrivacy('invalid.json', Buffer.from([0xff])), TypeError);
});

test('masked live captures carry no external social/identity links', async () => {
    const hits = [];
    for (const file of liveCaptures(fixtureFiles())) {
        const match = (await readFile(file, 'utf8')).match(SOCIAL);
        if (match) hits.push(`${path.relative(FIXTURES, file)}: ${match[0]}`);
    }
    assert.deepEqual(hits, [], `unmasked external links:\n${hits.join('\n')}`);
});

test('masking actually ran: live captures carry the masked climber id, and only it', async () => {
    const live = liveCaptures(fixtureFiles());
    assert.ok(live.length >= 7, 'expected the live-capture set to be present');

    for (const file of live) {
        const text = await readFile(file, 'utf8');
        // A Cloudflare response has no signed-in identity. Keep all privacy
        // scans above, but do not manufacture an owner in this response fixture.
        if (IDENTITY_FREE_CHALLENGES.has(path.relative(FIXTURES, file).split(path.sep).join('/'))) {
            assert.doesNotMatch(text, /\b(?:cid|c|d)=\d+/i);
            assert.doesNotMatch(text, new RegExp(MASKED_CLIMBER_ID));
            continue;
        }
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

// The reviewed synthetic rows are pinned in fixtures-privacy.browser.mts. This
// text-level backstop keeps their identifiers within the synthetic ranges in
// npm test, which runs before a push.
test('the Buddy List and Peak List fixtures link only synthetic identifiers', async () => {
    const ids = (html: string, key: string) => [...html.matchAll(new RegExp(`(?:[?&]|&amp;)${key}=(\\d+)`, 'g'))].map(match => match[1]!);
    const buddy = await readFile(path.join(FIXTURES, 'pages', 'report-buddy-list.html'), 'utf8');
    for (const [key, range] of [['cid', /^710\d{3}$/], ['aid', /^810\d{3}$/], ['pid', /^610\d{3}$/]] as const) {
        assert.ok(ids(buddy, key).length > 0, `the Buddy List links ${key} values`);
        for (const value of ids(buddy, key)) {
            if (key === 'cid' && value === MASKED_CLIMBER_ID) continue;
            assert.match(value, range, `Buddy List ${key}=${value} is outside the synthetic range`);
        }
    }
    const peaks = await readFile(path.join(FIXTURES, 'pages', 'list-peak-list.html'), 'utf8');
    assert.deepEqual([...new Set(ids(peaks, 'cid'))], [MASKED_CLIMBER_ID]);
    for (const [key, range] of [['aid', /^81010\d$/], ['pid', /^610\d{3}$/]] as const) {
        assert.ok(ids(peaks, key).length > 0, `the Peak List links ${key} values`);
        for (const value of ids(peaks, key)) assert.match(value, range, `Peak List ${key}=${value} is outside the synthetic range`);
    }
});

// The staged scan above is only half the guard. The other half is that
// .githooks/pre-commit actually runs, which depends on core.hooksPath — a
// setting nothing in the repository used to touch and no document mentioned, so
// it silently worked in one clone and was silently absent everywhere else.
test('the staged privacy scan is wired into every clone, not just a configured one', async () => {
    const repoRoot = REPO_ROOT;

    const hook = await readFile(path.join(repoRoot, '.githooks', 'pre-commit'), 'utf8');
    assert.match(hook, /scripts\/privacy-guard\.mts/,
        'the pre-commit hook must run the shared privacy scanner');

    const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.match(manifest.scripts.prepare ?? '', /install-git-hooks\.mts/,
        'npm install/ci must point this clone at .githooks');

    // Installing must never break an install, and must never overwrite a
    // hooksPath the user chose for this repository.
    assert.equal(HOOKS_PATH, '.githooks');
    const decide = (configuredPath: string | null, insideWorkTree = true) =>
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
