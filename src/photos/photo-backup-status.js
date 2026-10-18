// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// A confirmed GitHub snapshot and the local bookkeeping can finish separately.
// Do not describe an unfinished local status update as unsaved photo changes.
const statusMessages = (repository, time) => ({
    saved: `Backed up to ${repository} · local backup status needs updating.`,
    changes: `Photo-library changes are not yet backed up to ${repository}.`,
    unconfirmed: `Latest photo-library backup is not yet confirmed for ${repository}.`,
    current: `Up to date in ${repository} · ${time}`,
    restored: `Up to date · restored from ${repository} · ${time}`,
    first: `No photo-library backup confirmed yet for ${repository}.`,
    ready: `Ready to back up photo records to ${repository}.`,
});

const backupTime = state => {
    const stamp = state?.syncedAt || state?.restoredAt;
    const time = stamp ? new Date(stamp) : null;
    return Number.isFinite(time?.getTime()) ? time.toLocaleString() : null;
};

export function formatPhotoBackupStatus({ state, auto, repository }) {
    const prefix = auto ? 'Automatic backup on · ' : '';
    const time = backupTime(state);
    const messages = statusMessages(repository, time);
    if (state?.reconciliationPending) {
        const knownSnapshot = Number.isSafeInteger(state.generation) && state.generation >= 0
            && Number.isSafeInteger(state.catalogGeneration) && state.catalogGeneration >= 0;
        if (knownSnapshot && state.syncedAt && state.generation === state.catalogGeneration) {
            return prefix + messages.saved;
        }
        if (knownSnapshot) {
            return prefix + messages.changes;
        }
        return prefix + messages.unconfirmed;
    }
    if (time) return prefix + messages[state.syncedAt ? 'current' : 'restored'];
    return auto ? prefix + messages.first : messages.ready;
}

// Overlapping, unpainted sizing labels let the browser reserve the actual
// wrapping needed at any width or zoom, without a fixed height or hidden text
// in the live region. Busy feedback reuses the same reservation.
export function createPhotoBackupStatus(element) {
    const text = element.ownerDocument.createElement('span');
    text.textContent = element.textContent;
    element.classList.add('photo-backup-status');
    element.replaceChildren(text);
    let reservations = [];
    return (message, context = null) => {
        text.textContent = message;
        if (!context) return;
        const labels = Object.values(statusMessages(context.repository,
            new Date(2000, 11, 31, 23, 59, 59).toLocaleString()));
        if (!reservations.length) {
            reservations = labels.map(() => {
                const span = element.ownerDocument.createElement('span');
                span.setAttribute('aria-hidden', 'true');
                element.append(span);
                return span;
            });
        }
        labels.forEach((label, index) => {
            reservations[index].dataset.sizingLabel = `Automatic backup on · ${label}`;
        });
    };
}
