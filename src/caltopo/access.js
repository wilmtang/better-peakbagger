// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CALTOPO_PERMISSION } from './caltopo-import.js';
import { initMapAccess } from '../ui/map-access.js';

initMapAccess({ id: 'caltopo', name: 'CalTopo', permission: CALTOPO_PERMISSION });
