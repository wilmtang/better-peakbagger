// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { defineDomSuite } from '../../scripts/dom-tier.mts';
import { openSourceModule } from './source-module.mts';

const source = '<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1" xmlns:x="urn:extension">'
    + '<g:metadata><g:time>private</g:time><g:desc>Keep this text</g:desc></g:metadata>'
    + '<g:wpt lat="1" lon="2"><g:time>private</g:time><g:name>Camp</g:name></g:wpt>'
    + '<g:rte><g:rtept lat="1" lon="2"><g:time>private</g:time></g:rtept></g:rte>'
    + '<g:trk><g:trkseg><g:trkpt lat="1" lon="2"><g:ele>100</g:ele><g:time>private</g:time>'
    + '<g:extensions><x:time>private</x:time><x:hr>100</x:hr></g:extensions>'
    + '</g:trkpt></g:trkseg></g:trk></g:gpx>';
const invalid = ['<gpx>', '<html/>', '<!DOCTYPE gpx [<!ENTITY t "private">]><gpx><time>&t;</time></gpx>'];

export default defineDomSuite({
    name: 'GPX timestamps',
    cases: [{
        name: 'local timestamp projection covers metadata, waypoint, route, track and prefixed time elements',
        async run(context) {
            const modulePath = await openSourceModule(context, {
                source: new URL('../../src/gpx/gpx-timestamps.ts', import.meta.url),
                pagePath: '/fixture/gpx-timestamps.html',
                html: '<!doctype html><title>GPX timestamp fixture</title>',
            });
            const { output, failures } = await context.page.evaluate(async ({ url, xml, malformed }) => {
                const { removeGpxTimestamps } = await import(url) as typeof import('../../src/gpx/gpx-timestamps.ts');
                const projected = removeGpxTimestamps(xml);
                const rejections = malformed.map(item => {
                    try {
                        removeGpxTimestamps(item);
                        return null;
                    } catch (error) {
                        return error instanceof Error ? error.message : String(error);
                    }
                });
                return { output: projected, failures: rejections };
            }, { url: modulePath, xml: source, malformed: invalid });

            assert.doesNotMatch(output, /private|:time/, 'the local GPX projection must remove every timestamp');
            assert.match(output, /Keep this text/);
            assert.match(output, /<g:ele>100<\/g:ele>/);
            assert.match(output, /<g:name>Camp<\/g:name>/);
            assert.match(output, /<x:hr>100<\/x:hr>/);
            for (const [index, failure] of failures.entries()) {
                assert.match(failure ?? '', /invalid XML/, `malformed XML fixture ${index + 1} must be rejected`);
            }
        },
    }],
});
