// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanPhotoUrl, PHOTO_URL_LIMIT } from '../../src/photos/photo-url.js';

test('photo URL boundaries normalize HTTPS and reject credentials, other schemes, and oversized input', () => {
    assert.equal(cleanPhotoUrl('https://EXAMPLE.org:443/photo.png'), 'https://example.org/photo.png');
    for (const value of [null, {}, 123, '', '/photo.png', 'http://example.org/photo.png',
        'https://user@example.org/photo.png', 'https://user:secret@example.org/photo.png',
        'data:image/png;base64,AA', 'blob:https://example.org/id', 'file:///photo.png']) {
        assert.equal(cleanPhotoUrl(value), null, String(value));
    }
    const prefix = 'https://example.org/';
    const bounded = prefix + 'a'.repeat(PHOTO_URL_LIMIT - prefix.length);
    assert.equal(cleanPhotoUrl(bounded), bounded);
    assert.equal(cleanPhotoUrl(bounded + 'a'), null);
});
