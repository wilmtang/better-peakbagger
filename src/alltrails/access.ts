// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ALLTRAILS_PERMISSION } from './alltrails-import.ts';
import { initMapAccess } from '../ui/map-access.ts';

initMapAccess({ id: 'alltrails', name: 'AllTrails', permission: ALLTRAILS_PERMISSION });
