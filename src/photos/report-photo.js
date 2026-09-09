// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Reserved, non-resolving URLs preserve local references through the report's
// rich/Markdown/bracket conversions. Only the report renderer resolves pixels;
// the submit gate must replace every reference before a report is submitted.
const PREFIX = 'https://bpb-photo.invalid/';
const ID = /^[a-f0-9-]{36}$/;
const url = id => ID.test(id) ? `${PREFIX}${id}` : null;
const id = value => typeof value === 'string' && value.startsWith(PREFIX)
    && ID.test(value.slice(PREFIX.length)) ? value.slice(PREFIX.length) : null;
const ids = text => [...new Set((String(text).match(/https:\/\/bpb-photo\.invalid\/[a-f0-9-]{36}/g) || [])
    .map(id).filter(Boolean))];
const MAX_BYTES = 16 * 1024 * 1024;
const toDataUrl = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.readAsDataURL(blob);
});
const fromDataUrl = value => {
    if (typeof value !== 'string' || value.length > MAX_BYTES * 4 / 3 + 100
        || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(value)) {
        throw new Error('Use a PNG or JPEG photo smaller than 16 MiB.');
    }
    const [header, encoded] = value.split(',');
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('The photo is too large.');
    return new Blob([bytes], { type: header.slice(5, -7) });
};
export const reportPhoto = { PREFIX, url, id, ids, MAX_BYTES, toDataUrl, fromDataUrl };
