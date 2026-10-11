// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { favoriteClimbers as F } from '../src/favorites/favorite-climbers.js';
import { isPeakbaggerPageOrigin, PEAKBAGGER_ORIGIN } from '../src/peakbagger/peakbagger-origin.js';

const requestedOrigin = new URLSearchParams(location.hash.slice(1)).get('origin');
const origin = isPeakbaggerPageOrigin(requestedOrigin) ? requestedOrigin : PEAKBAGGER_ORIGIN;
location.replace(F.signedInBuddyListUrl(origin));
