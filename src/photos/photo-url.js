// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PHOTO_URL_LIMIT = 4096;

// Catalog fields, upload replies, and local secrets share this policy. Each
// boundary still validates independently; optional fields handle null locally.
export const cleanPhotoUrl = value => {
    if (typeof value !== 'string' || value.length > PHOTO_URL_LIMIT) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
    } catch { return null; }
};
