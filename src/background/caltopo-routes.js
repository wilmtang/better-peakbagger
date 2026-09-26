// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    CALTOPO_IMPORT_URL,
    CALTOPO_PERMISSION,
    MAX_CALTOPO_GPX_BYTES,
    prepareCaltopoImport,
} from '../caltopo/caltopo-import.js';
import { createGpxHandoffRoutes } from './gpx-handoff-routes.js';

export function createCaltopoRoutes(options) {
    return createGpxHandoffRoutes({
        ...options,
        provider: {
            name: 'CalTopo',
            buttonLabel: 'Send to CalTopo',
            permission: CALTOPO_PERMISSION,
            accessPage: 'caltopo/access.html',
            permissionType: 'CALTOPO_PERMISSION_REQUEST',
            prepareType: 'CALTOPO_IMPORT_PREPARE',
            importUrl: CALTOPO_IMPORT_URL,
            maxBytes: MAX_CALTOPO_GPX_BYTES,
            prepareImport: prepareCaltopoImport,
            isTargetUrl: url => url.origin === new URL(CALTOPO_IMPORT_URL).origin
                && url.pathname === '/map.html' && !url.search,
            wrongPageCode: 'sign-in-required',
            wrongPageMessage: 'Open CalTopo’s map, then return to Peakbagger and try again.',
            unavailableCode: 'caltopo-unavailable',
        },
    });
}
