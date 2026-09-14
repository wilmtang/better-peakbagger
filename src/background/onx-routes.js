// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    MAX_ONX_GPX_BYTES,
    ONX_IMPORT_URL,
    ONX_PERMISSION,
    prepareOnxImport,
} from '../onx/onx-import.js';
import { createGpxHandoffRoutes } from './gpx-handoff-routes.js';

export function createOnxRoutes(options) {
    return createGpxHandoffRoutes({
        ...options,
        provider: {
            name: 'onX',
            buttonLabel: 'Send to onX',
            permission: ONX_PERMISSION,
            accessPage: 'onx/access.html',
            permissionType: 'ONX_PERMISSION_REQUEST',
            prepareType: 'ONX_IMPORT_PREPARE',
            importUrl: ONX_IMPORT_URL,
            maxBytes: MAX_ONX_GPX_BYTES,
            prepareImport: prepareOnxImport,
            isTargetUrl: url => url.origin === new URL(ONX_IMPORT_URL).origin
                && url.pathname.toLowerCase() === '/backcountry/map/content/import',
            wrongPageCode: 'sign-in-required',
            wrongPageMessage: 'Sign in to onX if prompted, then return to Peakbagger and try again.',
            unavailableCode: 'onx-unavailable',
        },
    });
}
