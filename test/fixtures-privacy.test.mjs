// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Guards that no committed fixture (or fixture doc) leaks the identity of the
// account holder whose signed-in session the live captures came from.
//
// The banned identifiers are deliberately NOT stored here in plaintext — an
// earlier version listed them verbatim, which published the very identity it
// was guarding. Instead, every alphanumeric token in every fixture is salted-
// hashed and looked up in a hash denylist. To ban a new identifier:
//   node -e 'const c=require("node:crypto");console.log(c.createHash("sha256").update("bpb-privacy-v1:"+process.argv[1].toLowerCase()).digest("hex"))' '<identifier>'

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const SALT = 'bpb-privacy-v1';
const hashToken = token => createHash('sha256').update(`${SALT}:${token}`).digest('hex');

// Salted hashes of identifiers unique to the real account: name parts, the
// real climber id, social handles/ids, the account's own ascent ids. See the
// header comment for how to regenerate an entry.
const BANNED_HASHES = new Set([
    '78d003142abce7051585a991a3acdb87e1dec55937b0b25da13bc6b0b1d1a7d7',
    '5f6b569748331a97dc61d2e980f542adfaf5e79962d66e2fe8344209665c7eab',
    'a6d7a40e1ab361c0ae89d5db64dd766877237bb4467c3f77a52606e036594c43',
    '185059837f13f25091909a431d3e061070f3b25ca172a88e3ac91dc00fad7c0b',
    'edb535d0f4c1a8084395ad443fb5a39e82913b52a02373469e41e116f0517ca2',
    '72bde7b7ce8e4e44bf6625ad102f7bd49cd06af0f443b50ff4d3295af344c0ca',
    '046a89c3581897311e5986721cac8dc72bc2797d0994b7a75bb21fd83e7b7047',
    '10c027b3a245d4bf0c3044d032dfbe6641eb493a5c37c383ce66722e878a59da',
    '18833e56f98704d888a92abdd0d098e6a92c9b2b115fa5a934c6329ea7f7eac1'
]);

// Wayback captures of public peaks (other people's public data) legitimately
// carry external links; every other .html fixture is a masked live capture.
const WAYBACK = new Set([
    '1039-default-full-columns.html',
    '21500-y9998-sort-ascentdated.html',
    '21500-y9999-sort-ascentdate.html',
    '8241-y9999-sort-quality.html'
]);

const MASKED_CLIMBER_ID = '900001';
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
        const tokens = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
        for (const token of tokens) {
            if (BANNED_HASHES.has(hashToken(token))) {
                leaks.push(`${path.relative(FIXTURES, file)}: token "${token}"`);
            }
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

    // The personal pages are entirely the account holder's data, so every
    // climber-id URL param on them must be the masked id.
    const climberPages = live.filter(f => path.basename(f).startsWith('climber-'));
    assert.ok(climberPages.length >= 2, 'expected the personal climber-* pages');
    for (const file of climberPages) {
        const text = await readFile(file, 'utf8');
        const ids = new Set([...text.matchAll(/\b(?:cid|c|d)=(\d+)/g)].map(m => m[1]));
        assert.deepEqual([...ids], [MASKED_CLIMBER_ID],
            `${path.basename(file)} references climber ids other than the masked one`);
    }
});
