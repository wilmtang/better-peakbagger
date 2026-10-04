// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ONX_PERMISSION } from './onx-import.js';
import { initMapAccess } from '../ui/map-access.js';

initMapAccess({ id: 'onx', name: 'onX', permission: ONX_PERMISSION });
