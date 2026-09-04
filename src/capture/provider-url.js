// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure provider activity URL recognition shared by the background coordinator
// and the provider page. Both sides must agree on the provider/activity pair
// or the ownership and draft-identity checks fail closed.

const PROVIDER_HOSTS = Object.freeze({
    garmin: Object.freeze(['connect.garmin.com']),
    strava: Object.freeze(['strava.com', 'www.strava.com', 'm.strava.com']),
});

const PROFILE_PATTERNS = Object.freeze({
    garmin: /^\/(?:app|modern)\/profile\/([^/?#]+)(?:[/?#]|$)/i,
    strava: /^\/athletes\/(\d+)(?:[/?#]|$)/i,
});

export const isProviderHost = (provider, hostname) =>
    PROVIDER_HOSTS[provider]?.includes(String(hostname || '').toLowerCase()) === true;

export const providerProfileId = (href, provider, baseUrl) => {
    if (!href || !PROFILE_PATTERNS[provider]) return null;
    try {
        const url = new URL(href, baseUrl);
        if (url.protocol !== 'https:' || !isProviderHost(provider, url.hostname)) return null;
        const match = PROFILE_PATTERNS[provider].exec(url.pathname);
        return match ? decodeURIComponent(match[1]).toLowerCase() : null;
    } catch (_error) {
        return null;
    }
};

export const providerFromUrl = urlValue => {
    try {
        const url = new URL(urlValue);
        if (url.protocol !== 'https:') return null;
        // Garmin redirects its legacy /modern/activity route to /app/activity.
        // Accept both so a toolbar click that races that navigation still
        // identifies the same activity; generated links remain canonical.
        let match = /^\/(?:app|modern)\/activity\/(\d+)(?:[/?#]|$)/i.exec(url.pathname);
        if (isProviderHost('garmin', url.hostname) && match) {
            return { provider: 'garmin', activityId: match[1] };
        }
        match = /^\/activities\/(\d+)(?:[/?#]|$)/i.exec(url.pathname);
        if (isProviderHost('strava', url.hostname) && match) {
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
// (/app/activity/<id>), while parsing also accepts Garmin's redirecting
// /modern/activity alias. Junk ids or unknown providers yield null so nothing
// is written into the form.
export const providerActivityUrl = ({ provider, activityId } = {}) => {
    if (!/^\d+$/.test(String(activityId))) return null;
    if (provider === 'garmin') return `https://connect.garmin.com/app/activity/${activityId}`;
    if (provider === 'strava') return `https://www.strava.com/activities/${activityId}`;
    return null;
};
