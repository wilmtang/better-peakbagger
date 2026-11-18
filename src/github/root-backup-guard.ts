// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface RootBackupReview {
    path: string;
    scope: unknown;
    localSignature: string | null;
    remoteSignature: string | null;
}

export interface RootBackupBaseline {
    scope?: unknown;
    signature?: unknown;
}

export interface GuardRootBackupInput {
    path: string;
    localSignature: string | null;
    remoteSignature: string | null;
    scope: unknown;
    baseline?: RootBackupBaseline | null;
    review?: {
        path?: unknown;
        scope?: unknown;
        localSignature?: unknown;
        remoteSignature?: unknown;
    } | null;
}

export interface RootBackupReviewError extends Error {
    code: 'backup-review';
    review: RootBackupReview;
}

// Compare content, not timestamps. A review authorizes only the exact local
// snapshot, remote snapshot and connection the user was shown.
export function guardRootBackup({ path, localSignature, remoteSignature, scope, baseline, review }: GuardRootBackupInput): void {
    if (remoteSignature === localSignature) return;
    const known = !!baseline && baseline.scope === scope && typeof baseline.signature === 'string';
    if (known && baseline.signature === remoteSignature) return;
    if (!known && remoteSignature === null) return;
    if (review?.path === path && review.scope === scope
        && review.localSignature === localSignature && review.remoteSignature === remoteSignature) return;
    const error: RootBackupReviewError = Object.assign(
        new Error('The GitHub backup differs. Restore it, or review replacing it with this device’s copy.'),
        {
            code: 'backup-review' as const,
            review: { path, scope, localSignature, remoteSignature },
        },
    );
    throw error;
}
