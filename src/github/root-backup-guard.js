// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Compare content, not timestamps. A review authorizes only the exact local
// snapshot, remote snapshot and connection the user was shown.
export function guardRootBackup({ path, localSignature, remoteSignature, scope, baseline, review }) {
    if (remoteSignature === localSignature) return;
    const known = baseline?.scope === scope && typeof baseline.signature === 'string';
    if (known && baseline.signature === remoteSignature) return;
    if (!known && remoteSignature === null) return;
    if (review?.path === path && review.scope === scope
        && review.localSignature === localSignature && review.remoteSignature === remoteSignature) return;
    throw Object.assign(new Error('The GitHub backup differs. Restore it, or review replacing it with this device’s copy.'), {
        code: 'backup-review', review: { path, scope, localSignature, remoteSignature },
    });
}
