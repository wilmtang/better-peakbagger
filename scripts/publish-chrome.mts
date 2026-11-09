// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { readBoundedResponseText } from '../src/net/bounded-text.js';

const API_ROOT = 'https://chromewebstore.googleapis.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RESPONSE_BYTES = 64 * 1024;
const IN_PROGRESS_STATES = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']);
const SUCCESS_STATES = new Set(['SUCCEEDED', 'UPLOAD_SUCCEEDED']);
const SUBMITTED_STATES = new Set([
    'PENDING_REVIEW',
    'PUBLISHED',
    'PUBLISHED_TO_TESTERS',
]);
const FAILED_SUBMISSION_STATES = new Set(['CANCELLED', 'REJECTED', 'STAGED']);

const REPOSITORY = 'wilmtang/better-peakbagger';
const RECEIPT_TTL_MS = 24 * 60 * 60_000;

type RevisionStatus = { state?: string; distributionChannels?: { crxVersion?: string }[] };
type ApiBody = {
    error?: { message?: string; details?: unknown[] };
    publishedItemRevisionStatus?: RevisionStatus; submittedItemRevisionStatus?: RevisionStatus;
    lastAsyncUploadState?: string; uploadState?: string; crxVersion?: string; state?: string;
    warningInfo?: { warnings?: { description?: string; reason?: string }[] };
};
type ErrorContext = { phase: string; endpoint: string; status?: number; code?: string; outcomeUnknown?: boolean; cause?: unknown };
type MatchedSubmission = { kind: 'matched'; state: string; version: string };
type SubmissionEvidence = MatchedSubmission | { kind: 'missing' } | { kind: 'missing-channels'; state?: string }
    | { kind: 'mismatch'; state?: string; versions: string[] } | { kind: 'wrong-state'; state?: string; versions: string[] };
export type ChromePublishResult = { uploadState?: string; uploadedVersion: string; publishState: string; reconciled: true };
export type ChromeOptions = {
    token?: string; publisherId?: string; extensionId?: string; packageBytes: Uint8Array; expectedVersion: string;
    fetchImpl?: typeof fetch; sleep?: (milliseconds: number) => Promise<void>; pollIntervalMs?: number;
    maxPolls?: number; requestTimeoutMs?: number; pollTimeoutMs?: number; maxResponseBytes?: number;
    now?: () => number; setTimeoutImpl?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
    clearTimeoutImpl?: (timer: ReturnType<typeof setTimeout> | undefined) => void;
};
type ReceiptBase = { schemaVersion: 1; repository: typeof REPOSITORY; sourceCommit: string; expectedVersion: string;
    publisherId: string; extensionId: string; packageSha256: string; createdAt: string };
export type ChromeUploadReceipt = ReceiptBase & (
    { outcome: 'uploaded'; uploadState: string; apiReportedVersion?: string }
    | { outcome: 'existing-submission'; submittedVersion: string; publishState: string }
);
export type ChromeUploadOptions = ChromeOptions & { sourceCommit: string; repository?: string; evidenceExpiresAt?: string };
export type ChromeReceiptPublishOptions = ChromeUploadOptions & { receipt: unknown; metadataReviewed: boolean };
type RequestOptions = Omit<RequestInit, 'headers'> & { headers?: Record<string, string>; phase: string; mutates?: boolean; requestTimeoutMs?: number };

export class ChromeWebStoreRequestError extends Error {
    phase: string; endpoint: string; status?: number; code: string; outcomeUnknown: boolean;
    constructor(message: string, {
        phase,
        endpoint,
        status,
        code = 'request-failed',
        outcomeUnknown = false,
        cause,
    }: ErrorContext) {
        super(message, { cause });
        this.name = 'ChromeWebStoreRequestError';
        this.phase = phase;
        this.endpoint = endpoint;
        this.status = status;
        this.code = code;
        this.outcomeUnknown = outcomeUnknown;
    }
}

function revisionVersions(revision: RevisionStatus | undefined) {
    return revision?.distributionChannels
        ?.map((channel) => channel.crxVersion)
        .filter((version): version is string => typeof version === 'string' && version.length > 0) || [];
}

function submittedRevisionEvidence(status: ApiBody, expectedVersion: string): SubmissionEvidence {
    const revision = status?.submittedItemRevisionStatus;
    if (!revision) return { kind: 'missing' };
    const versions = [...new Set(revisionVersions(revision))];
    if (versions.length === 0) {
        return { kind: 'missing-channels', state: revision.state };
    }
    if (versions.some((version) => version !== expectedVersion)) {
        return { kind: 'mismatch', state: revision.state, versions };
    }
    if (!SUBMITTED_STATES.has(revision.state ?? '')) {
        return { kind: 'wrong-state', state: revision.state, versions };
    }
    return { kind: 'matched', state: revision.state!, version: expectedVersion };
}

export function requireUnusedChromeVersion(status: ApiBody, expectedVersion: string) {
    const publishedVersions = revisionVersions(status.publishedItemRevisionStatus);
    if (publishedVersions.includes(expectedVersion)) {
        throw new Error(`Chrome Web Store version ${expectedVersion} is already published.`);
    }
    const submittedVersions = revisionVersions(status.submittedItemRevisionStatus);
    if (status.submittedItemRevisionStatus) {
        const versionDetail = submittedVersions.length > 0
            ? `version(s) ${submittedVersions.join(', ')}`
            : 'a revision without distribution-channel version evidence';
        throw new Error(
            `Chrome Web Store already has submitted ${versionDetail}. `
            + 'Inspect the submission in the Developer Dashboard before uploading.',
        );
    }
    if (IN_PROGRESS_STATES.has(status.lastAsyncUploadState ?? '')
        || SUCCESS_STATES.has(status.lastAsyncUploadState ?? '')) {
        throw new Error(
            `Chrome Web Store reports a recent ${status.lastAsyncUploadState} upload. `
            + 'Inspect its version in the Developer Dashboard before retrying.',
        );
    }
}

function requireValue(name: string, value: unknown) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

function requestFailure(message: string, context: ErrorContext, cause?: unknown) {
    return new ChromeWebStoreRequestError(
        `Chrome Web Store ${context.phase} request (${context.endpoint}) ${message}`,
        { ...context, cause },
    );
}

function parseApiBody(input: unknown): ApiBody {
    const object = (value: unknown): Record<string, unknown> => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an API object');
        return value as Record<string, unknown>;
    };
    const string = (record: Record<string, unknown>, key: string) => {
        if (record[key] !== undefined && typeof record[key] !== 'string') throw new Error(`Invalid API ${key}`);
    };
    const body = object(input);
    for (const key of ['lastAsyncUploadState', 'uploadState', 'crxVersion', 'state']) string(body, key);
    for (const key of ['submittedItemRevisionStatus', 'publishedItemRevisionStatus']) {
        if (body[key] === undefined) continue;
        const revision = object(body[key]);
        string(revision, 'state');
        if (revision.distributionChannels !== undefined) {
            if (!Array.isArray(revision.distributionChannels)) throw new Error('Invalid API distribution channels');
            for (const channel of revision.distributionChannels) string(object(channel), 'crxVersion');
        }
    }
    if (body.warningInfo !== undefined) {
        const info = object(body.warningInfo);
        if (info.warnings !== undefined) {
            if (!Array.isArray(info.warnings)) throw new Error('Invalid API warnings');
            for (const warning of info.warnings) { const detail = object(warning); string(detail, 'description'); string(detail, 'reason'); }
        }
    }
    if (body.error !== undefined) {
        const error = object(body.error);
        string(error, 'message');
        if (error.details !== undefined && !Array.isArray(error.details)) throw new Error('Invalid API error details');
    }
    return body as ApiBody;
}

async function apiRequest({
    fetchImpl,
    token,
    url,
    options = {},
    phase,
    mutates = false,
    requestTimeoutMs,
    maxResponseBytes,
    setTimeoutImpl,
    clearTimeoutImpl,
}: { fetchImpl: typeof fetch; token: string; url: string; options?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };
    phase: string; mutates?: boolean; requestTimeoutMs: number; maxResponseBytes: number;
    setTimeoutImpl: NonNullable<ChromeOptions['setTimeoutImpl']>; clearTimeoutImpl: NonNullable<ChromeOptions['clearTimeoutImpl']>;
}): Promise<ApiBody> {
    const endpoint = new URL(url).pathname;
    const controller = new AbortController();
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const context = { phase, endpoint, outcomeUnknown: mutates };
    const timeout = new Promise<never>((resolve, reject) => {
        timer = setTimeoutImpl(() => {
            controller.abort();
            reject(requestFailure(
                `exceeded its ${requestTimeoutMs}ms deadline.${mutates ? ' Its outcome is unknown.' : ''}`,
                { ...context, code: 'deadline-exceeded' },
            ));
        }, requestTimeoutMs);
    });

    const operation = (async () => {
        try {
            response = await fetchImpl(url, {
                ...options,
                headers: {
                    Authorization: `Bearer ${token}`,
                    ...options.headers,
                },
                signal: controller.signal,
            });
        } catch (error) {
            if (controller.signal.aborted) throw error;
            throw requestFailure('failed before a response was received.', {
                ...context,
                code: 'transport-failed',
            }, error);
        }

        let bodyText;
        try {
            bodyText = await readBoundedResponseText(response, {
                maxBytes: maxResponseBytes,
                maxChars: maxResponseBytes,
                signal: controller.signal,
                label: `Chrome Web Store ${phase} response`,
            });
        } catch (error) {
            if (controller.signal.aborted) throw error;
            throw requestFailure('could not be read within its response budget.', {
                ...context,
                status: response.status,
                code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'body-read-failed',
                outcomeUnknown: mutates && response.ok,
            }, error);
        }

        let body: ApiBody = {};
        if (bodyText) {
            try {
                body = parseApiBody(JSON.parse(bodyText));
            } catch (error) {
                throw requestFailure('returned malformed JSON.', {
                    ...context,
                    status: response.status,
                    code: 'malformed-json',
                    outcomeUnknown: mutates && response.ok,
                }, error);
            }
        }

        if (!response.ok) {
            const apiMessage = body.error?.message || response.statusText || 'request failed';
            const apiDetails = body.error?.details?.length
                ? ` (${JSON.stringify(body.error.details)})`
                : '';
            throw requestFailure(`failed with HTTP ${response.status}: ${apiMessage}${apiDetails}`, {
                phase,
                endpoint,
                status: response.status,
                code: 'api-error',
                outcomeUnknown: false,
            });
        }
        return body;
    })();

    try {
        return await Promise.race([operation, timeout]);
    } catch (error) {
        if (error instanceof ChromeWebStoreRequestError) throw error;
        if (controller.signal.aborted) {
            throw requestFailure(`exceeded its ${requestTimeoutMs}ms deadline.`, {
                ...context,
                status: response?.status,
                code: 'deadline-exceeded',
                outcomeUnknown: mutates && (!response || response.ok),
            }, error);
        }
        throw error;
    } finally {
        clearTimeoutImpl(timer);
    }
}

function submissionFailure(evidence: SubmissionEvidence, expectedVersion: string) {
    if (evidence.kind === 'mismatch') {
        return new Error(
            `Chrome Web Store submitted version(s) ${evidence.versions.join(', ')}; expected ${expectedVersion}`,
        );
    }
    if (evidence.kind === 'wrong-state' && FAILED_SUBMISSION_STATES.has(evidence.state ?? '')) {
        return new Error(
            `Chrome Web Store submitted version ${expectedVersion} has unexpected state ${evidence.state}`,
        );
    }
    return null;
}

async function executeChrome(options: ChromeOptions, mode: 'combined'): Promise<ChromePublishResult>;
async function executeChrome(options: ChromeUploadOptions, mode: 'upload'): Promise<ChromeUploadReceipt>;
async function executeChrome(options: ChromeReceiptPublishOptions, mode: 'publish'): Promise<ChromePublishResult>;
async function executeChrome({
    token,
    publisherId,
    extensionId,
    packageBytes,
    expectedVersion,
    fetchImpl = fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    pollIntervalMs = 5_000,
    maxPolls = 60,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_RESPONSE_BYTES,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    ...modeOptions
}: ChromeOptions & Partial<ChromeReceiptPublishOptions>, mode: 'combined' | 'upload' | 'publish'): Promise<ChromePublishResult | ChromeUploadReceipt> {
    const normalizedToken = requireValue('CHROME_WEBSTORE_TOKEN', token);
    const normalizedPublisherId = requireValue('CHROME_PUBLISHER_ID', publisherId);
    const normalizedExtensionId = requireValue('CHROME_EXTENSION_ID', extensionId);
    const normalizedVersion = requireValue('expectedVersion', expectedVersion);
    if (!/^[a-p]{32}$/.test(normalizedExtensionId)) {
        throw new Error('CHROME_EXTENSION_ID must be a 32-character Chrome extension ID');
    }
    if (!(packageBytes instanceof Uint8Array) || packageBytes.byteLength === 0) {
        throw new Error('Chrome release package is empty');
    }
    for (const [name, value] of [
        ['requestTimeoutMs', requestTimeoutMs],
        ['pollTimeoutMs', pollTimeoutMs],
        ['maxResponseBytes', maxResponseBytes],
        ['maxPolls', maxPolls],
    ] as const) {
        if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
        throw new Error('pollIntervalMs must not be negative');
    }

    // Own the exact bytes before any asynchronous preflight. A caller cannot
    // mutate its Uint8Array later and falsify the sent-bytes digest.
    const ownedPackage = new Uint8Array(packageBytes);
    const packageSha256 = createHash('sha256').update(ownedPackage).digest('hex');
    const receiptBase = mode === 'combined' ? undefined : receiptIdentity({
        sourceCommit: modeOptions.sourceCommit, repository: modeOptions.repository,
        expectedVersion: normalizedVersion, publisherId: normalizedPublisherId,
        extensionId: normalizedExtensionId, packageSha256,
    });
    const receiptTime = mode === 'combined' ? undefined : new Date(now()).toISOString();
    const evidenceExpiresAt = modeOptions.evidenceExpiresAt;
    const evidenceDeadline = evidenceExpiresAt === undefined ? undefined : Date.parse(evidenceExpiresAt);
    const assertFreshEvidence = () => {
        if (mode === 'combined' || evidenceDeadline === undefined) return;
        if (!Number.isFinite(evidenceDeadline) || new Date(evidenceDeadline).toISOString() !== evidenceExpiresAt
            || !Number.isFinite(now()) || evidenceDeadline <= now()) throw new Error('Release verification evidence has expired or lacks a valid expiry timestamp');
    };
    assertFreshEvidence();
    let receipt: ChromeUploadReceipt | undefined;
    if (mode === 'publish') {
        if (modeOptions.metadataReviewed !== true) throw new Error('The uploaded draft version and Google metadata must be reviewed before publication');
        receipt = validateChromeUploadReceipt(modeOptions.receipt, receiptBase!, now());
    }
    const makeReceipt = (detail: { outcome: 'uploaded'; uploadState: string; apiReportedVersion?: string }
        | { outcome: 'existing-submission'; submittedVersion: string; publishState: string }): ChromeUploadReceipt => ({
        ...receiptBase!, createdAt: receiptTime!, ...detail,
    });
    const itemName = `publishers/${encodeURIComponent(normalizedPublisherId)}/items/${normalizedExtensionId}`;
    const uploadUrl = `${API_ROOT}/upload/v2/${itemName}:upload`;
    const itemUrl = `${API_ROOT}/v2/${itemName}`;
    const request = (url: string, options: RequestOptions) => {
        const {
            phase,
            mutates = false,
            requestTimeoutMs: perRequestTimeoutMs = requestTimeoutMs,
            ...fetchOptions
        } = options;
        return apiRequest({
            fetchImpl,
            token: normalizedToken,
            url,
            options: fetchOptions,
            phase,
            mutates,
            requestTimeoutMs: perRequestTimeoutMs,
            maxResponseBytes,
            setTimeoutImpl,
            clearTimeoutImpl,
        });
    };
    const fetchStatus = async (phase: string, timeout = requestTimeoutMs) => {
        const status = await request(`${itemUrl}:fetchStatus`, { phase, requestTimeoutMs: timeout });
        if (mode !== 'combined') {
            for (const key of ['publishedItemRevisionStatus', 'submittedItemRevisionStatus'] as const) {
                const revision = status[key];
                if (revision === undefined) continue;
                const channels = revision.distributionChannels;
                if (!channels?.length || channels.some(channel => !channel.crxVersion?.trim())) {
                    throw new Error(`Chrome has unproven ${key} distribution-channel versions; inspect the Developer Dashboard`);
                }
            }
        }
        return status;
    };

    const existingStatus = await fetchStatus('preflight');
    const existingSubmission = submittedRevisionEvidence(existingStatus, normalizedVersion);
    if (existingSubmission.kind === 'matched') {
        if (mode === 'upload') return makeReceipt({ outcome: 'existing-submission',
            submittedVersion: existingSubmission.version, publishState: existingSubmission.state });
        return {
            uploadState: existingStatus.lastAsyncUploadState,
            uploadedVersion: existingSubmission.version,
            publishState: existingSubmission.state,
            reconciled: true,
        };
    }
    if (mode === 'publish') {
        if (receipt!.outcome === 'existing-submission') throw new Error('The previously reconciled submitted revision disappeared; inspect the Developer Dashboard, no publish was sent');
        if (existingStatus.submittedItemRevisionStatus) throw new Error('A different or unproven Chrome submitted revision exists; inspect the Developer Dashboard');
        if (revisionVersions(existingStatus.publishedItemRevisionStatus).includes(normalizedVersion)) throw new Error(`Chrome Web Store version ${normalizedVersion} is already published.`);
        // Sync uploads need not populate lastAsyncUploadState. When the field is
        // present it must agree with completed processing; never publish through
        // a failed, unknown or still-running upload.
        if (existingStatus.lastAsyncUploadState !== undefined && !SUCCESS_STATES.has(existingStatus.lastAsyncUploadState)) {
            throw new Error(`Chrome upload state is not ready for reviewed publication: ${existingStatus.lastAsyncUploadState}`);
        }
    } else {
        if (mode === 'upload' && existingStatus.lastAsyncUploadState !== undefined
            && ![...IN_PROGRESS_STATES, ...SUCCESS_STATES, 'FAILED', 'UPLOAD_FAILED'].includes(existingStatus.lastAsyncUploadState)) {
            throw new Error('Chrome reports an unknown upload state; inspect the Developer Dashboard before uploading');
        }
        requireUnusedChromeVersion(existingStatus, normalizedVersion);
    }

    const pollSubmission = async (phase: string) => {
        const deadline = now() + pollTimeoutMs;
        let lastEvidence: SubmissionEvidence = { kind: 'missing' };
        for (let poll = 0; poll < maxPolls; poll += 1) {
            if (poll > 0) {
                const remainingBeforeSleep = deadline - now();
                if (remainingBeforeSleep <= 0) break;
                await sleep(Math.min(pollIntervalMs, remainingBeforeSleep));
            }
            const remaining = deadline - now();
            if (remaining <= 0) break;
            const status = await fetchStatus(phase, Math.min(requestTimeoutMs, remaining));
            lastEvidence = submittedRevisionEvidence(status, normalizedVersion);
            if (lastEvidence.kind === 'matched') return lastEvidence;
            const failure = submissionFailure(lastEvidence, normalizedVersion);
            if (failure) throw failure;
        }
        const detail = lastEvidence.kind === 'missing-channels'
            ? 'the submitted revision had no distribution-channel version'
            : 'no submitted revision was visible';
        throw new Error(
            `Chrome Web Store did not prove submitted version ${normalizedVersion}: ${detail}`,
        );
    };

    let uploadState: string | undefined = receipt?.outcome === 'uploaded' ? receipt.uploadState : undefined;
    if (mode !== 'publish') {
        let upload: ApiBody;
        assertFreshEvidence();
        try {
            upload = await request(uploadUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: ownedPackage,
                phase: 'upload',
                mutates: true,
            });
        } catch (error) {
            if (!(error instanceof ChromeWebStoreRequestError) || !error.outcomeUnknown) throw error;
            let evidence;
            try {
                evidence = submittedRevisionEvidence(
                    await fetchStatus('upload reconciliation'),
                    normalizedVersion,
                );
            } catch (reconciliationError) {
                throw new Error(
                    'Chrome Web Store upload outcome is unknown, and status reconciliation failed. '
                    + 'Inspect the Developer Dashboard before retrying; the upload was not replayed.',
                    { cause: reconciliationError },
                );
            }
            if (evidence.kind === 'matched') {
                if (mode === 'upload') return makeReceipt({ outcome: 'existing-submission',
                    submittedVersion: evidence.version, publishState: evidence.state });
                return {
                    uploadState: undefined,
                    uploadedVersion: evidence.version,
                    publishState: evidence.state,
                    reconciled: true,
                };
            }
            throw new Error(
                'Chrome Web Store upload outcome is unknown. Inspect the Developer Dashboard before retrying; '
                + 'the upload was not replayed.',
                { cause: error },
            );
        }

        uploadState = upload.uploadState;
        const uploadedVersion = upload.crxVersion;
        const uploadDeadline = now() + pollTimeoutMs;
        for (let poll = 0; IN_PROGRESS_STATES.has(uploadState ?? '') && poll < maxPolls; poll += 1) {
            const remainingBeforeSleep = uploadDeadline - now();
            if (remainingBeforeSleep <= 0) break;
            await sleep(Math.min(pollIntervalMs, remainingBeforeSleep));
            const remaining = uploadDeadline - now();
            if (remaining <= 0) break;
            const status = await fetchStatus(
                'upload processing',
                Math.min(requestTimeoutMs, remaining),
            );
            uploadState = status.lastAsyncUploadState;
        }

        if (!SUCCESS_STATES.has(uploadState ?? '')) {
            throw new Error(`Chrome Web Store upload did not succeed (state: ${uploadState || 'missing'})`);
        }
        if (uploadedVersion !== undefined && uploadedVersion !== normalizedVersion) {
            throw new Error(
                `Chrome Web Store processed version ${uploadedVersion}; expected ${normalizedVersion}`,
            );
        }

        if (mode === 'upload') return makeReceipt({ outcome: 'uploaded', uploadState: uploadState!,
            ...(uploadedVersion ? { apiReportedVersion: uploadedVersion } : {}) });
    }

    if (mode === 'publish') validateChromeUploadReceipt(receipt, receiptBase!, now());
    assertFreshEvidence();
    let publish: ApiBody;
    try {
        publish = await request(`${itemUrl}:publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                publishType: 'DEFAULT_PUBLISH',
                blockOnWarnings: true,
            }),
            phase: 'publish',
            mutates: true,
        });
    } catch (error) {
        if (!(error instanceof ChromeWebStoreRequestError) || !error.outcomeUnknown) throw error;
        try {
            const evidence = await pollSubmission('publish reconciliation');
            return {
                uploadState,
                uploadedVersion: evidence.version,
                publishState: evidence.state,
                reconciled: true,
            };
        } catch (reconciliationError) {
            throw new Error(
                'Chrome Web Store publish outcome is unknown, and the expected submitted revision '
                + 'could not be reconciled. Inspect the Developer Dashboard before retrying; '
                + 'the publish request was not replayed.',
                { cause: reconciliationError },
            );
        }
    }

    if (publish.warningInfo?.warnings?.length) {
        const descriptions = publish.warningInfo.warnings
            .map((warning) => warning.description || warning.reason)
            .filter(Boolean)
            .join('; ');
        throw new Error(
            `Chrome Web Store blocked publishing on warnings: ${descriptions || 'unspecified warning'}`,
        );
    }
    if (!SUBMITTED_STATES.has(publish.state ?? '')) {
        throw new Error(
            `Chrome Web Store returned an unexpected publish state: ${publish.state || 'missing'}`,
        );
    }

    const evidence = await pollSubmission('submission reconciliation');
    return {
        uploadState,
        uploadedVersion: evidence.version,
        publishState: evidence.state,
        reconciled: true,
    };
}


type ReceiptIdentity = Omit<ReceiptBase, 'createdAt'>;
function receiptIdentity(input: { sourceCommit?: string; repository?: string; expectedVersion: string;
    publisherId: string; extensionId: string; packageSha256: string }): ReceiptIdentity {
    if (!/^[a-f0-9]{40}$/.test(input.sourceCommit ?? '')) throw new Error('Chrome upload receipt requires a full source commit SHA');
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input.expectedVersion)) throw new Error('Chrome upload receipt requires an exact release version');
    if ((input.repository ?? REPOSITORY) !== REPOSITORY) throw new Error('Chrome upload receipt requires the canonical repository');
    return { schemaVersion: 1, repository: REPOSITORY, sourceCommit: input.sourceCommit!, expectedVersion: input.expectedVersion,
        publisherId: input.publisherId, extensionId: input.extensionId, packageSha256: input.packageSha256 };
}

export function validateChromeUploadReceipt(input: unknown, expected: ReceiptIdentity, now = Date.now()): ChromeUploadReceipt {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Chrome upload receipt is missing or malformed');
    const receipt = input as Record<string, unknown>;
    const common = ['schemaVersion', 'repository', 'sourceCommit', 'expectedVersion', 'publisherId', 'extensionId', 'packageSha256', 'createdAt', 'outcome'];
    for (const key of Object.keys(expected) as (keyof ReceiptIdentity)[]) {
        if (receipt[key] !== expected[key]) throw new Error(`Chrome upload receipt does not match ${key}`);
    }
    const timestamp = typeof receipt.createdAt === 'string' ? Date.parse(receipt.createdAt) : NaN;
    if (!Number.isFinite(now) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== receipt.createdAt
        || timestamp > now || now - timestamp > RECEIPT_TTL_MS) throw new Error('Chrome upload receipt is stale, future-dated or lacks a valid timestamp');
    if (receipt.outcome === 'uploaded') {
        if (typeof receipt.uploadState !== 'string' || !SUCCESS_STATES.has(receipt.uploadState)
            || (receipt.apiReportedVersion !== undefined && receipt.apiReportedVersion !== expected.expectedVersion)
            || Object.keys(receipt).some(key => ![...common, 'uploadState', 'apiReportedVersion'].includes(key))) {
            throw new Error('Chrome upload receipt lacks a successful, consistent upload outcome');
        }
    } else if (receipt.outcome === 'existing-submission') {
        if (receipt.submittedVersion !== expected.expectedVersion || typeof receipt.publishState !== 'string'
            || !SUBMITTED_STATES.has(receipt.publishState)
            || Object.keys(receipt).some(key => ![...common, 'submittedVersion', 'publishState'].includes(key))) {
            throw new Error('Chrome upload receipt lacks exact reconciled submission evidence');
        }
    } else throw new Error('Chrome upload receipt has an unknown outcome');
    // Every field in the discriminated union was checked above. The hash is a
    // local package/sent-bytes binding, never proof of the current remote draft.
    const base: ReceiptBase = { ...expected, createdAt: receipt.createdAt as string };
    return receipt.outcome === 'uploaded'
        ? { ...base, outcome: 'uploaded', uploadState: receipt.uploadState as string,
            ...(receipt.apiReportedVersion === undefined ? {} : { apiReportedVersion: receipt.apiReportedVersion as string }) }
        : { ...base, outcome: 'existing-submission', submittedVersion: receipt.submittedVersion as string,
            publishState: receipt.publishState as string };
}

export const publishChrome = (options: ChromeOptions) => executeChrome(options, 'combined');
export const uploadChrome = (options: ChromeUploadOptions) => executeChrome(options, 'upload');
export const publishChromeFromReceipt = (options: ChromeReceiptPublishOptions) => executeChrome(options, 'publish');

export function chromePublisherArguments(args: string[]) {
    if (args.length === 1 && !['upload', 'publish'].includes(args[0]!) && !args[0]!.startsWith('--')) {
        return { mode: 'combined' as const, archive: args[0]! };
    }
    if (args[0] === 'upload' && args.length === 3 && args.slice(1).every(value => value && !value.startsWith('--'))) {
        return { mode: 'upload' as const, archive: args[1]!, receipt: args[2]! };
    }
    if (args[0] === 'publish' && args.length === 4 && args[3] === '--metadata-reviewed'
        && args.slice(1, 3).every(value => value && !value.startsWith('--'))) {
        return { mode: 'publish' as const, archive: args[1]!, receipt: args[2]! };
    }
    throw new Error('Usage: node scripts/publish-chrome.mts RELEASE_PACKAGE.zip | upload ARCHIVE RECEIPT | publish ARCHIVE RECEIPT --metadata-reviewed');
}

export async function readChromeReceipt(filename: string): Promise<unknown> {
    const file = await open(filename, 'r');
    try {
        const maximum = 64 * 1024;
        const buffer = Buffer.alloc(maximum + 1);
        let used = 0;
        while (used < buffer.byteLength) {
            const { bytesRead } = await file.read(buffer, used, buffer.byteLength - used, null);
            if (!bytesRead) break;
            used += bytesRead;
        }
        if (used > maximum) throw new Error('Chrome upload receipt exceeds its 64KB budget');
        return JSON.parse(buffer.subarray(0, used).toString('utf8'));
    } finally { await file.close(); }
}

async function main() {
    const args = chromePublisherArguments(process.argv.slice(2));
    const manifest = JSON.parse(await readFile('manifest.json', 'utf8')) as { version: string };
    const options = { token: process.env.CHROME_WEBSTORE_TOKEN, publisherId: process.env.CHROME_PUBLISHER_ID,
        extensionId: process.env.CHROME_EXTENSION_ID, packageBytes: await readFile(args.archive), expectedVersion: manifest.version };
    if (args.mode === 'upload') {
        // Reserve the path before contacting Google. Existing or concurrent runs
        // must fail before dispatching a second upload. A failed reservation is
        // intentionally retained: inspect the store, never blindly replay it.
        const file = await open(args.receipt, 'wx');
        try {
            const receipt = await uploadChrome({ ...options, sourceCommit: process.env.GITHUB_SHA ?? '',
                evidenceExpiresAt: process.env.BPB_RELEASE_EVIDENCE_EXPIRES_AT });
            await file.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
            console.log(receipt.outcome === 'uploaded'
                ? `Chrome accepted the package upload for local expected version ${receipt.expectedVersion}; review the latest draft and Google metadata before publication.`
                : `Reconciled existing Chrome submission ${receipt.submittedVersion}; no new successful upload is claimed.`);
        } catch (error) {
            try {
                await file.truncate(0);
                await file.write(`${JSON.stringify({ outcome: 'not-confirmed', instruction: 'Inspect the Developer Dashboard before retrying; no successful upload receipt was recorded.' })}\n`, 0, 'utf8');
            } catch { /* Keep any partial reservation when the filesystem itself fails. */ }
            throw new Error(`Chrome upload receipt was not recorded. Its reservation remains; inspect the Developer Dashboard before retrying. ${error instanceof Error ? error.message : 'Unknown upload failure.'}`, { cause: error });
        } finally { await file.close(); }
    } else {
        const result = args.mode === 'publish'
            ? await publishChromeFromReceipt({ ...options, sourceCommit: process.env.GITHUB_SHA ?? '', evidenceExpiresAt: process.env.BPB_RELEASE_EVIDENCE_EXPIRES_AT,
                receipt: await readChromeReceipt(args.receipt), metadataReviewed: true })
            : await publishChrome(options);
        console.log(`Submitted Chrome Web Store version ${result.uploadedVersion} for review.`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : 'Chrome publisher failed');
        process.exitCode = 1;
    });
}
