// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { removeGpxTimestamps } from '../../src/gpx/gpx-timestamps.js';

test('local timestamp projection covers metadata, waypoint, route, track and prefixed time elements', () => {
    const dom = new JSDOM();
    const previous = { DOMParser: globalThis.DOMParser, XMLSerializer: globalThis.XMLSerializer };
    Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer });
    try {
        const source = '<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1" xmlns:x="urn:extension">'
            + '<g:metadata><g:time>private</g:time><g:desc>Keep this text</g:desc></g:metadata>'
            + '<g:wpt lat="1" lon="2"><g:time>private</g:time><g:name>Camp</g:name></g:wpt>'
            + '<g:rte><g:rtept lat="1" lon="2"><g:time>private</g:time></g:rtept></g:rte>'
            + '<g:trk><g:trkseg><g:trkpt lat="1" lon="2"><g:ele>100</g:ele><g:time>private</g:time>'
            + '<g:extensions><x:time>private</x:time><x:hr>100</x:hr></g:extensions>'
            + '</g:trkpt></g:trkseg></g:trk></g:gpx>';
        const output = removeGpxTimestamps(source);
        assert.doesNotMatch(output, /private|:time/);
        assert.match(output, /Keep this text/);
        assert.match(output, /<g:ele>100<\/g:ele>/);
        assert.match(output, /<g:name>Camp<\/g:name>/);
        assert.match(output, /<x:hr>100<\/x:hr>/);
        for (const invalid of ['<gpx>', '<html/>', '<!DOCTYPE gpx [<!ENTITY t "private">]><gpx><time>&t;</time></gpx>']) {
            assert.throws(() => removeGpxTimestamps(invalid), /invalid XML/);
        }
    } finally { Object.assign(globalThis, previous); dom.window.close(); }
});
