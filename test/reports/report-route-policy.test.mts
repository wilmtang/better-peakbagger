// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { protectedReportDocument, protectReportHeaders, REPORT_CSP } from '../../src/reports/report-security-policy.ts';

const origin = 'https://www.peakbagger.com';
const alias = (word: string, mask: number) => [...word].map((character, index) => mask & 2 ** index
    ? '%' + character.charCodeAt(0).toString(16).toUpperCase() : character).join('');

test('encoded ordinary profile/editor names do not receive report-only CSP', () => {
    for (const route of ['/climber/%63limber.aspx', '/climber/climber%2Easpx', '/%63limber/%61scentedit.aspx',
        '/climber/ascentedit.aspx', '/climber/ascent.aspxevil', '/climber/ascent.aspx%65vil', '/x/ascent.aspx',
        ...Array.from({ length: 6 }, (_, index) => '/' + 'climber'.slice(0, index + 1) + '/ascent.aspx'),
        '/climberx/ascent.aspx', '/climber0/ascent.aspx', '/climber_/ascent.aspx', '/climber%7E/ascent.aspx']) {
        assert.equal(protectedReportDocument(origin + route), false, route);
    }
    assert.equal(protectedReportDocument(origin + '/climber/%63limber.aspx?return=%25%2f%00'), false);
});

test('every mixed literal/encoded ASCII byte combination of the report route stays protected', () => {
    let count = 0;
    for (let mask = 0; mask < 2 ** 18; mask++) {
        const route = '/' + alias('climber', mask) + '/' + alias('ascent.aspx', Math.floor(mask / 128));
        if (!protectedReportDocument(origin + route)) assert.fail(route);
        count++;
    }
    assert.equal(count, 262144);
    for (const route of ['/CLIMBER/AsCeNt.AsPx', '//climber//%41scent%2easpx/extra',
        '/climber/ascent.aspx;extra', '/climber/ascent.aspx.', '/climber/%2561scent.aspx',
        '/climber%2fascent.aspx', '/climber/%61scent.aspx%3fextra']) assert.equal(protectedReportDocument(origin + route), true, route);
});

test('encoded supported MasterMap spellings retain the child-document exception', () => {
    let count = 0;
    for (const word of ['MasterMap.aspx', 'mastermap.aspx']) for (let mask = 0; mask < 2 ** 17; mask++) {
        const route = '/' + alias('map', mask) + '/' + alias(word, Math.floor(mask / 8));
        if (protectedReportDocument(origin + route, 'sub_frame')) assert.fail(route);
        count++;
    }
    assert.equal(count, 262144);
    for (const folder of ['m', 'ma', 'mapx', 'map0', 'x', 'map_']) {
        assert.equal(protectedReportDocument(`${origin}/${folder}/%4dasterMap.aspx`, 'sub_frame'), true, folder);
    }
    assert.equal(protectedReportDocument(origin + '/map/MaStErMaP.AsPx?x=1', 'sub_frame'), false);
    assert.equal(protectedReportDocument(origin + '/map/%254dasterMap.aspx', 'sub_frame'), true);
});

test('folder exclusions match a decoded-route oracle for ASCII mutations', () => {
    for (const [folder, file, type] of [['climber', 'ascent.aspx', 'main_frame'], ['map', 'MasterMap.aspx', 'sub_frame']] as const) {
        for (let index = 0; index < folder.length; index++) for (const character of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_~-') {
            const changed = folder.slice(0, index) + character + folder.slice(index + 1);
            for (const mask of [0, 2 ** folder.length - 1, 0b1010101]) {
                const url = `${origin}/${alias(changed, mask)}/${file}`;
                const expected = type === 'main_frame' ? changed.toLowerCase() === folder : changed.toLowerCase() !== folder;
                assert.equal(protectedReportDocument(url, type), expected, url);
            }
        }
    }
});

test('only unambiguous unreserved path encodings are exempt from the residual guard', () => {
    for (let byte = 0; byte < 256; byte++) {
        const encoded = '%' + byte.toString(16).padStart(2, '0');
        const unreserved = /^[A-Za-z0-9._~-]$/.test(String.fromCharCode(byte));
        assert.equal(protectedReportDocument(`${origin}/climber/xx${encoded}yy.aspx`), !unreserved, encoded);
        assert.equal(protectedReportDocument(`${origin}/climber/climber.aspx?text=${encoded}`), false, 'query ' + encoded);
    }
    for (const route of ['/climber/climber.aspx%', '/climber/climber.aspx%a', '/climber/%GGfoo.aspx',
        '/%252e%252e/climber.aspx', '/x/%252e/climber.aspx', '/climber/climber.aspx%2e',
        '/climber/ascent.aspx%2e.', '/climber/ascent.aspx.%2e.', '/climber/ascent.aspx%2e..',
        '/climber/ascent.aspx%2e./extra', '/%63limber./ascent.aspx', '/climber./%61scent.aspx',
        '/climber/climber.aspx.']) {
        assert.equal(protectedReportDocument(origin + route), true, route);
    }
});

test('origin, document type, site policy and challenge boundaries remain intact', () => {
    for (const host of ['www.peakbagger.com', 'peakbagger.com']) {
        assert.equal(protectedReportDocument(`https://${host}:8443/climber/%61scent.aspx`), true);
    }
    for (const url of ['http://www.peakbagger.com/climber/ascent.aspx', 'https://foo.peakbagger.com/climber/ascent.aspx',
        'https://www.foo.peakbagger.com/climber/ascent.aspx', 'https://peakbagger.com.evil.test/climber/ascent.aspx',
        'https://peakbagger.com@evil.test/climber/ascent.aspx']) assert.equal(protectedReportDocument(url), false, url);
    assert.equal(protectedReportDocument(origin + '/climber/%25foo.aspx', 'image'), false);
    assert.equal(protectedReportDocument('https://user.name:pass@www.peakbagger.com/climber/%61scent.aspx'), true);
    const original = { name: 'Content-Security-Policy', value: "img-src 'none'" };
    assert.deepEqual(protectReportHeaders({ url: origin + '/climber/%61scent.aspx', responseHeaders: [original] }),
        { responseHeaders: [original, { name: 'Content-Security-Policy', value: REPORT_CSP }] });
    assert.deepEqual(protectReportHeaders({ url: origin + '/climber/%25foo.aspx', responseHeaders: [{ name: 'CF-Mitigated', value: 'challenge' }] }), {});
});
