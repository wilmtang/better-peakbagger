// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// When an earlier capture may still be used. "Remove GPX timestamps" applies to
// GPX sent to Peakbagger without qualification (PRIVACY.md), so turning it on
// retires a capture made while it was off: that capture kept no timeless copy.
// Turning it off needs no recapture; the one-time Include timestamps choice
// already covers that direction.

export interface CaptureReusePreferences {
    retainWaypoints: boolean; removeGpxTimestamps: boolean; fillAscentDetails: boolean;
    fillTripInfo: boolean; fillWildernessNights: boolean; fillExternalUrl: boolean;
}

export const sameCapturePreferences = (
    captured: CaptureReusePreferences | null | undefined,
    current: CaptureReusePreferences | null | undefined,
) => !!captured && !!current
    && captured.retainWaypoints === current.retainWaypoints
    && captured.fillAscentDetails === current.fillAscentDetails
    && captured.fillTripInfo === current.fillTripInfo
    && captured.fillWildernessNights === current.fillWildernessNights
    && captured.fillExternalUrl === current.fillExternalUrl
    && !(current.removeGpxTimestamps && !captured.removeGpxTimestamps);

// Whether a capture's timed GPX may no longer be delivered to a draft because
// timestamp removal was turned on after it was captured.
export const timestampsTurnedOnSince = (
    captured: Pick<CaptureReusePreferences, 'removeGpxTimestamps'> | null | undefined,
    currentRemove: boolean,
) => currentRemove && captured?.removeGpxTimestamps !== true;

export const TIMESTAMPS_TURNED_ON_MESSAGE = 'Remove GPX timestamps was turned on after this capture. Capture the activity again.';
