// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    GAIA_MAP_URL,
    GAIA_PERMISSION,
    MAX_GAIA_GPX_BYTES,
    prepareGaiaImport,
} from '../gaia/gaia-import.js';
import { createGpxHandoffRoutes } from './gpx-handoff-routes.js';

export function createGaiaRoutes(options) {
    return createGpxHandoffRoutes({
        ...options,
        provider: {
            name: 'Gaia',
            buttonLabel: 'Send to Gaia',
            permission: GAIA_PERMISSION,
            accessPage: 'gaia/access.html',
            permissionType: 'GAIA_PERMISSION_REQUEST',
            prepareType: 'GAIA_IMPORT_PREPARE',
            importUrl: GAIA_MAP_URL,
            maxBytes: MAX_GAIA_GPX_BYTES,
            prepareImport: prepareGaiaImport,
            isTargetUrl: url => url.origin === new URL(GAIA_MAP_URL).origin && url.pathname === '/map/',
            wrongPageCode: 'gaia-unavailable',
            wrongPageMessage: 'Gaia did not stay on its map. No GPX was sent.',
            unavailableCode: 'gaia-unavailable',
        },
    });
}
