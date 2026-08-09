// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { gunzipSync } from 'node:zlib';

const decodeUtf8 = input =>
    new TextDecoder('utf-8', { fatal: true }).decode(input);

const decodeBase64GzipUtf8 = input => {
    const encoded = decodeUtf8(input).replaceAll(/\s/g, '');
    if (encoded.length === 0 || encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        throw new Error('Fixture is not canonical base64');
    }
    return decodeUtf8(gunzipSync(Buffer.from(encoded, 'base64')));
};

// Match longest suffix first: an encoded GPX must never fall back to a generic
// text decoder merely because its final extension is also registered.
export const FIXTURE_PRIVACY_MANIFEST = Object.freeze([
    Object.freeze({ suffix: '.gpx.gz.b64', format: 'gpx+xml', decoder: 'base64+gzip+utf8' }),
    Object.freeze({ suffix: '.html', format: 'html', decoder: 'utf8' }),
    Object.freeze({ suffix: '.gpx', format: 'gpx+xml', decoder: 'utf8' }),
    Object.freeze({ suffix: '.xml', format: 'xml', decoder: 'utf8' }),
    Object.freeze({ suffix: '.md', format: 'markdown', decoder: 'utf8' }),
]);

const DECODERS = Object.freeze({
    utf8: decodeUtf8,
    'base64+gzip+utf8': decodeBase64GzipUtf8,
});

export function decodeFixtureForPrivacy(relativePath, input) {
    const registration = FIXTURE_PRIVACY_MANIFEST.find(({ suffix }) =>
        relativePath.endsWith(suffix));
    if (!registration) {
        throw new Error(`Unregistered fixture extension: ${relativePath}`);
    }
    return {
        format: registration.format,
        text: DECODERS[registration.decoder](input),
    };
}
