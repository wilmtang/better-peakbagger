// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { GAIA_PERMISSION } from './gaia-import.js';
import { initMapAccess } from '../ui/map-access.js';

initMapAccess({ id: 'gaia', name: 'Gaia', permission: GAIA_PERMISSION });
