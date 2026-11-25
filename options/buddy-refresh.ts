// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { favoriteClimbers as F } from '../src/favorites/favorite-climbers.ts';
import { isPeakbaggerPageOrigin, PEAKBAGGER_ORIGIN } from '../src/peakbagger/peakbagger-origin.ts';

const requestedOrigin = new URLSearchParams(location.hash.slice(1)).get('origin');
const origin = requestedOrigin && isPeakbaggerPageOrigin(requestedOrigin) ? requestedOrigin : PEAKBAGGER_ORIGIN;
const targetUrl = F.signedInBuddyListUrl(origin);
if (targetUrl) location.replace(targetUrl);
