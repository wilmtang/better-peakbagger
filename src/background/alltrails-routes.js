// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    ALLTRAILS_IMPORT_URL,
    ALLTRAILS_PERMISSION,
    MAX_ALLTRAILS_GPX_BYTES,
    prepareAlltrailsImport,
} from '../alltrails/alltrails-import.js';
import { createGpxHandoffRoutes } from './gpx-handoff-routes.js';

export function createAlltrailsRoutes(options) {
    return createGpxHandoffRoutes({
        ...options,
        provider: {
            name: 'AllTrails',
            buttonLabel: 'Send to AllTrails',
            permission: ALLTRAILS_PERMISSION,
            accessPage: 'alltrails/access.html',
            permissionType: 'ALLTRAILS_PERMISSION_REQUEST',
            prepareType: 'ALLTRAILS_IMPORT_PREPARE',
            importUrl: ALLTRAILS_IMPORT_URL,
            maxBytes: MAX_ALLTRAILS_GPX_BYTES,
            prepareImport: prepareAlltrailsImport,
            isTargetUrl: url => url.origin === new URL(ALLTRAILS_IMPORT_URL).origin
                && url.pathname.replace(/\/+$/, '') === '/explore/custom-routes/new',
            wrongPageCode: 'sign-in-required',
            wrongPageMessage: 'Sign in to AllTrails if prompted, then return to Peakbagger and try again.',
            unavailableCode: 'alltrails-unavailable',
        },
    });
}
