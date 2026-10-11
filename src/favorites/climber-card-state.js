// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { favoriteClimbers as F } from './favorite-climbers.js';
import * as I from './ignored-climbers.js';

// A visible name is presentation; the validated profile URL owns identity.
export const climberCardTarget = (href, label, base) => {
    const cid = I.profileId(href, base);
    const name = String(label || '').replace(/\s+/g, ' ').trim();
    if (!cid || !name || /^(?:my home page|home|profile|view profile|climber page)$/i.test(name)) return null;
    return { cid, name: name.slice(0, F.NAME_LIMIT), url: F.climberPageUrl(cid) };
};

// Rendering never authorizes a write. Worker mutations recheck current lists
// in their shared lane, including inactive custom favorites and sync reserves.
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
    const buddyIntent = membership?.buddyIntents?.find(entry => entry.cid === cid);
    const unavailable = !membership?.ignored || !!membership.error;
    const self = ownerCid != null && cid === ownerCid;
    const blocked = unavailable || ignored || pending;
    const custom = settings ? settings.favoritesSource === 'custom' : null;
    let note = membership?.error || (!membership?.ignored ? 'Loading climber lists…' : '');
    if (!note && (buddyPending || (buddyIntent && buddyIntent.status !== 'confirmed'))) note = 'Check the pending buddy change before ignoring.';
    if (!note && ignored) note = 'Unignore to add to your lists.';
    if (!note && pending) note = 'Finish the pending ignored-climber sync before adding to favorites.';
    return {
        self, custom, favorite, ignored, buddy, pending, note, buddyIntent,
        buddyBlocked: !buddy && (blocked || buddyPending),
        favoriteDisabled: self || busy || !settings || (favorite ? false : blocked
            || membership.favorites.entries.length >= F.LIMIT),
        ignoreDisabled: self || busy || (ignored ? false : unavailable || favorite || protectedBuddy
            || buddyPending || !!buddyIntent || membership.ignored.entries.length >= I.LIMIT),
        ignoreDetail: ignored ? 'Show their reports again' : favorite && protectedBuddy
            ? 'Remove from both lists to ignore' : favorite ? 'Remove from favorites to ignore'
                : protectedBuddy ? (buddy ? 'Remove from your Buddy List to ignore' : 'Refresh your Buddy List before ignoring')
                    : membership?.ignored?.entries.length >= I.LIMIT ? 'Ignored climbers can hold up to 1,500 entries.'
                        : 'Hide their reports',
        favoriteLimit: !favorite && membership?.favorites?.entries.length >= F.LIMIT,
    };
};
