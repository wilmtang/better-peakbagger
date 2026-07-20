// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure provider activity URL recognition shared by the background coordinator
// and the provider page. Both sides must agree on the provider/activity pair
// or the ownership and draft-identity checks fail closed.

export const providerFromUrl = urlValue => {
    try {
        const url = new URL(urlValue);
        let match = /^\/app\/activity\/(\d+)(?:[/?#]|$)/i.exec(url.pathname);
        if (url.hostname === 'connect.garmin.com' && match) {
            return { provider: 'garmin', activityId: match[1] };
        }
        match = /^\/activities\/(\d+)(?:[/?#]|$)/i.exec(url.pathname);
        if (/(^|\.)strava\.com$/i.test(url.hostname) && match) {
            return { provider: 'strava', activityId: match[1] };
        }
    } catch (_error) {
        // Unsupported/malformed URLs are represented as null.
    }
    return null;
};

// The inverse: rebuild a canonical activity URL from the { provider,
// activityId } a capture job already stores, so the raw tab URL never has to
// be persisted. The Garmin form mirrors what providerFromUrl recognizes
// (/app/activity/<id>). Junk ids or unknown providers yield null so nothing is
// written into the form.
export const providerActivityUrl = ({ provider, activityId } = {}) => {
    if (!/^\d+$/.test(String(activityId))) return null;
    if (provider === 'garmin') return `https://connect.garmin.com/app/activity/${activityId}`;
    if (provider === 'strava') return `https://www.strava.com/activities/${activityId}`;
    return null;
};
