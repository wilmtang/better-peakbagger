// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { utils } from 'playwright-core/lib/coreBundle';

export const DEM_FIXTURE_CONTENT_TYPE = 'image/webp';
const SIZE = 512;
const RIDGE_MERCATOR = 5.7e-5;

// Sample one continuous synthetic range in global Mercator space, keeping the
// same terrain across adjacent tiles and levels. Terrarium RGB bytes encode
// elevation, so lossy image compression would change the geometry itself.
export function syntheticDemPixels(z, x, y) {
    const data = Buffer.alloc(SIZE * SIZE * 4), dimension = 2 ** z;
    for (let row = 0; row < SIZE; row++) {
        const my = (y + (row + 0.5) / SIZE) / dimension;
        for (let column = 0; column < SIZE; column++) {
            const mx = (x + (column + 0.5) / SIZE) / dimension;
            const fine = Math.sin(2 * Math.PI * mx / RIDGE_MERCATOR) * Math.cos(2 * Math.PI * my / RIDGE_MERCATOR);
            const coarse = Math.sin(2 * Math.PI * mx / (8 * RIDGE_MERCATOR)) * Math.cos(2 * Math.PI * my / (8 * RIDGE_MERCATOR));
            const value = 300 + 1300 * (1 + 0.75 * fine + 0.25 * coarse) + 32768;
            const whole = Math.floor(value), offset = (row * SIZE + column) * 4;
            data[offset] = (whole >> 8) & 0xff;
            data[offset + 1] = whole & 0xff;
            data[offset + 2] = Math.min(255, Math.floor((value - whole) * 256));
            data[offset + 3] = 255;
        }
    }
    return { width: SIZE, height: SIZE, data };
}

export const syntheticDemWebp = (z, x, y) => utils.encodeWebp(syntheticDemPixels(z, x, y), { lossless: true });
