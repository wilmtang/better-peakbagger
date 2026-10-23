// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { favoriteClimbers as F } from './favorite-climbers.js';
import * as I from './ignored-climbers.js';

export const SAVED_BUDDY_ACCOUNT_MESSAGE = 'Saved Buddy List belongs to a previous Peakbagger account. Sign in to that account, then refresh its list in Settings.';

// A visible name is presentation; the validated profile URL owns identity.
export const climberCardTarget = (href, label, base) => {
    const cid = I.profileId(href, base);
    const name = String(label || '').replace(/\s+/g, ' ').trim();
    if (!cid || !name || /^(?:(?:my )?home page|home|profile|view profile|climber page)$/i.test(name)) return null;
    return { cid, name: name.slice(0, F.NAME_LIMIT), url: F.climberPageUrl(cid) };
};

// Missing information is not an empty list. Only a matching, already-loaded
// profile's native Social Networking section can establish availability.
export const climberProfileLists = (doc, url, cid) => {
    const unknown = { buddy: null, reverse: null };
    if (I.profileId(url) !== cid) return unknown;
    const heading = [...doc.querySelectorAll('#ListLabel h4')]
        .find(node => node.textContent.trim() === 'Social Networking');
    let list = heading?.nextElementSibling;
    while (list && !list.matches('ul,h4')) list = list.nextElementSibling;
    if (!list?.matches('ul')) return unknown;
    const links = [...list.querySelectorAll('a[href]')].flatMap(anchor => {
        try {
            const link = new URL(anchor.getAttribute('href'), url);
            return link.origin === new URL(url).origin && !link.username && !link.password
                && link.searchParams.getAll('cid').length === 1 && link.searchParams.get('cid') === String(cid) ? [link] : [];
        } catch { return []; }
    });
    const complete = links.some(link => /^\/climber\/compare\.aspx$/i.test(link.pathname));
    const available = report => links.some(link => /^\/report\/report\.aspx$/i.test(link.pathname)
        && link.searchParams.getAll('r').length === 1 && link.searchParams.get('r') === report);
    return {
        buddy: available('b') ? true : complete || /\bNo Buddy list created yet\b/i.test(list.textContent) ? false : null,
        reverse: available('rb') ? true : complete ? false : null,
    };
};

// Rendering never authorizes a write. Worker mutations recheck current lists
// in their shared lane, including inactive custom favorites and sync reserves.
export const buddyIntentState = ({ cid, ownerCid, membership, now = Date.now() }) => {
    const buddyIntent = membership?.buddyIntents?.find(entry => entry.cid === cid);
    return { buddyIntent,
        buddyInFlight: !!buddyIntent && buddyIntent.leaseUntil > now,
        buddyCheckBlocked: !!buddyIntent && buddyIntent.ownerCid !== ownerCid };
};
export const climberCardState = ({ cid, ownerCid, settings, membership, busy = false,
    nativeBuddy = false, buddyPending = false } = {}) => {
    const favorite = !!membership?.favorites?.entries.some(entry => entry.cid === cid);
    const ignored = !!membership?.ignored?.entries.some(entry => entry.cid === cid);
    const savedBuddy = !!membership?.buddies?.entries.some(entry => entry.cid === cid);
    const buddy = nativeBuddy || (ownerCid != null && membership?.buddies?.ownerCid === ownerCid && savedBuddy);
    // Preserve the worker's conservative protection even for another account's
    // saved cache, without calling those people the current account's buddies.
    const protectedBuddy = nativeBuddy || savedBuddy;
    const pending = !!membership?.pendingIds?.has(cid);
    const { buddyIntent, buddyInFlight, buddyCheckBlocked } = buddyIntentState({ cid, ownerCid, membership });
    const cachedBuddyBlocked = !ignored && !favorite && !buddyIntent && !buddyPending && savedBuddy && !buddy;
    const unavailable = !membership?.ignored || !!membership.error;
    const self = ownerCid != null && cid === ownerCid;
    const blocked = unavailable || ignored || pending;
    const custom = settings ? settings.favoritesSource === 'custom' : null;
    let note = membership?.error || (!membership?.ignored ? 'Loading climber lists…' : '');
    if (!note && buddyInFlight) note = 'Buddy change in progress.';
    if (!note && buddyCheckBlocked) note = 'Check buddy status from the original account.';
    if (!note && (buddyPending || (buddyIntent && buddyIntent.status !== 'confirmed'))) note = 'Check the pending buddy change before ignoring.';
    if (!note && ignored) note = 'Unignore to add to your lists.';
    if (!note && pending) note = 'Finish the pending ignored-climber sync before adding to favorites.';
    return {
        self, custom, favorite, ignored, buddy, pending, note, buddyIntent, buddyInFlight, buddyCheckBlocked,
        cachedBuddyBlocked, savedBuddyOwnerCid: cachedBuddyBlocked ? membership.buddies.ownerCid : null,
        buddyBlocked: !buddy && (blocked || buddyPending),
        favoriteDisabled: self || busy || !settings || (favorite ? false : blocked
            || membership.favorites.entries.length >= F.LIMIT),
        ignoreDisabled: self || busy || (ignored ? false : unavailable || favorite || protectedBuddy
            || buddyPending || !!buddyIntent || membership.ignored.entries.length >= I.LIMIT),
        ignoreDetail: ignored ? 'Show their reports again' : favorite && protectedBuddy
            ? 'Remove from both lists to ignore' : favorite ? 'Remove from favorites to ignore'
                : protectedBuddy ? (buddy ? 'Remove from your Buddy List to ignore'
                    : SAVED_BUDDY_ACCOUNT_MESSAGE)
                    : membership?.ignored?.entries.length >= I.LIMIT ? 'Ignored climbers can hold up to 1,500 entries.'
                        : 'Hide their reports',
        favoriteLimit: !favorite && membership?.favorites?.entries.length >= F.LIMIT,
    };
};
