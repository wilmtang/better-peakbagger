// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — post-ImgBB-commit transaction boundary.
//
// Once commitUpload succeeds, the provider URL and local deletion capability
// are durable facts. Report insertion, reference persistence, and journal
// cleanup may still fail, but none of them may turn that committed upload back
// into an ambiguous provider outcome.

import { photoLibrary as Library } from './photo-library.ts';

export type CommittedUploadErrorCode = 'not-inserted' | 'reference-pending';

export interface CommittedUploadErrorOptions {
    cause?: unknown;
}

class CommittedUploadError extends Error {
    readonly code: string;

    constructor(code: string, message: string, { cause = null }: CommittedUploadErrorOptions = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'CommittedUploadError';
        this.code = code;
    }
}

export interface PhotoUploadReferenceLike {
    kind: string;
    cid: string | number | null;
    aid: string | number | null;
    pid: string | number | null;
}

export interface PhotoUploadInsertIdentity {
    cid?: string | number | null;
    aid?: string | number | null;
    pid?: string | number | null;
}

export interface PhotoUploadInsertResponse {
    ok?: boolean;
    identity?: PhotoUploadInsertIdentity | null;
    error?: {
        message?: unknown;
    } | null;
}

export interface PhotoUploadTransactionStore {
    putPhoto(photo: unknown): Promise<unknown>;
    deleteOperation(operationId: string): Promise<unknown>;
}

export interface PhotoUploadTransactionOperation {
    operationId: string;
    returnToken?: string | null;
}

export interface FinishCommittedUploadOptions {
    store?: PhotoUploadTransactionStore | null;
    operation?: PhotoUploadTransactionOperation | null;
    photo?: unknown;
    insert?: ((options: {
        returnToken: string;
        photo: NonNullable<ReturnType<typeof Library.cleanPhoto>>;
    }) => Promise<PhotoUploadInsertResponse | null | undefined>) | null;
    now?: () => string;
}

export interface FinishCommittedUploadResult {
    photo: NonNullable<ReturnType<typeof Library.cleanPhoto>>;
    inserted: boolean;
    cleanupPending: boolean;
}

const sameReference = (left: PhotoUploadReferenceLike, right: PhotoUploadReferenceLike): boolean => left.kind === right.kind
    && left.cid === right.cid
    && left.aid === right.aid
    && left.pid === right.pid;

const referenceFromInsert = (inserted: PhotoUploadInsertResponse, now: string) => ({
    kind: inserted.identity?.aid ? ('ascent' as const) : ('ascent-draft' as const),
    cid: inserted.identity?.cid ?? null,
    aid: inserted.identity?.aid ?? null,
    pid: inserted.identity?.pid ?? null,
    insertedAt: now,
});

const finishCommittedUpload = async ({
    store,
    operation,
    photo: value,
    insert,
    now = () => new Date().toISOString(),
}: FinishCommittedUploadOptions = {}): Promise<FinishCommittedUploadResult> => {
    let photo = Library.cleanPhoto(value);
    if (!store || !operation || !photo
        || !['uploaded', 'unreachable'].includes(photo.remote.state)) {
        throw new TypeError('committed upload finalization requires an uploaded photo and journal');
    }

    let inserted = false;
    if (operation.returnToken) {
        if (!insert) {
            throw new CommittedUploadError(
                'not-inserted',
                'The photo was uploaded and saved in the library, but it could not be inserted into the report. '
                    + 'You can insert it from the photo library.',
            );
        }
        let response: PhotoUploadInsertResponse | null | undefined;
        try {
            response = await insert({
                returnToken: operation.returnToken,
                photo,
            });
        } catch (cause) {
            throw new CommittedUploadError(
                'not-inserted',
                'The photo was uploaded and saved in the library, but it could not be inserted into the report. '
                    + 'You can insert it from the photo library.',
                { cause },
            );
        }
        if (!response?.ok) {
            const detail = typeof response?.error?.message === 'string'
                ? ` ${response.error.message}`
                : '';
            throw new CommittedUploadError(
                'not-inserted',
                'The photo was uploaded and saved in the library, but it could not be inserted into the report. '
                    + `You can insert it from the photo library.${detail}`,
            );
        }
        inserted = true;
        const reference = referenceFromInsert(response, now());
        if (!photo.references.some(existing => sameReference(existing, reference))) {
            const referenced = Library.addReference(photo, reference, now());
            if (!referenced) {
                throw new CommittedUploadError(
                    'reference-pending',
                    'The photo was uploaded and inserted, but its local report reference could not be recorded. '
                        + 'The uploaded photo remains in the library.',
                );
            }
            try {
                photo = Library.cleanPhoto(await store.putPhoto(referenced)) || referenced;
            } catch (cause) {
                throw new CommittedUploadError(
                    'reference-pending',
                    'The photo was uploaded and inserted, but its local report reference could not be recorded. '
                        + 'The uploaded photo remains in the library.',
                    { cause },
                );
            }
        }
    }

    let cleanupPending = false;
    try {
        await store.deleteOperation(operation.operationId);
    } catch {
        // Recovery retries this idempotently. Journal cleanup is bookkeeping,
        // not a reason to retract a known provider or report success.
        cleanupPending = true;
    }
    return { photo, inserted, cleanupPending };
};

export const photoUploadTransaction = {
    CommittedUploadError,
    finishCommittedUpload,
};
