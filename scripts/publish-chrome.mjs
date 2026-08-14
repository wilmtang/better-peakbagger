import { readFile } from 'node:fs/promises';
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

export class ChromeWebStoreRequestError extends Error {
    constructor(message, {
        phase,
        endpoint,
        status,
        code = 'request-failed',
        outcomeUnknown = false,
        cause,
    }) {
        super(message, { cause });
        this.name = 'ChromeWebStoreRequestError';
        this.phase = phase;
        this.endpoint = endpoint;
        this.status = status;
        this.code = code;
        this.outcomeUnknown = outcomeUnknown;
    }
}

function revisionVersions(revision) {
    return revision?.distributionChannels
        ?.map((channel) => channel.crxVersion)
        .filter(Boolean) || [];
}

function submittedRevisionEvidence(status, expectedVersion) {
    const revision = status?.submittedItemRevisionStatus;
    if (!revision) return { kind: 'missing' };
    const versions = [...new Set(revisionVersions(revision))];
    if (versions.length === 0) {
        return { kind: 'missing-channels', state: revision.state };
    }
    if (versions.some((version) => version !== expectedVersion)) {
        return { kind: 'mismatch', state: revision.state, versions };
    }
    if (!SUBMITTED_STATES.has(revision.state)) {
        return { kind: 'wrong-state', state: revision.state, versions };
    }
    return { kind: 'matched', state: revision.state, version: expectedVersion };
}

export function requireUnusedChromeVersion(status, expectedVersion) {
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
    if (IN_PROGRESS_STATES.has(status.lastAsyncUploadState)
        || SUCCESS_STATES.has(status.lastAsyncUploadState)) {
        throw new Error(
            `Chrome Web Store reports a recent ${status.lastAsyncUploadState} upload. `
            + 'Inspect its version in the Developer Dashboard before retrying.',
        );
    }
}

function requireValue(name, value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

function requestFailure(message, context, cause) {
    return new ChromeWebStoreRequestError(
        `Chrome Web Store ${context.phase} request (${context.endpoint}) ${message}`,
        { ...context, cause },
    );
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
}) {
    const endpoint = new URL(url).pathname;
    const controller = new AbortController();
    let response;
    let timer;
    const context = { phase, endpoint, outcomeUnknown: mutates };
    const timeout = new Promise((resolve, reject) => {
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
                code: error?.code || 'body-read-failed',
                outcomeUnknown: mutates && response.ok,
            }, error);
        }

        let body = {};
        if (bodyText) {
            try {
                body = JSON.parse(bodyText);
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

function submissionFailure(evidence, expectedVersion) {
    if (evidence.kind === 'mismatch') {
        return new Error(
            `Chrome Web Store submitted version(s) ${evidence.versions.join(', ')}; expected ${expectedVersion}`,
        );
    }
    if (evidence.kind === 'wrong-state' && FAILED_SUBMISSION_STATES.has(evidence.state)) {
        return new Error(
            `Chrome Web Store submitted version ${expectedVersion} has unexpected state ${evidence.state}`,
        );
    }
    return null;
}

export async function publishChrome({
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
}) {
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
    ]) {
        if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
        throw new Error('pollIntervalMs must not be negative');
    }

    const itemName = `publishers/${encodeURIComponent(normalizedPublisherId)}/items/${normalizedExtensionId}`;
    const uploadUrl = `${API_ROOT}/upload/v2/${itemName}:upload`;
    const itemUrl = `${API_ROOT}/v2/${itemName}`;
    const request = (url, options = {}) => {
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
    const fetchStatus = (phase, timeout = requestTimeoutMs) => request(
        `${itemUrl}:fetchStatus`,
        { phase, requestTimeoutMs: timeout },
    );

    const existingStatus = await fetchStatus('preflight');
    const existingSubmission = submittedRevisionEvidence(existingStatus, normalizedVersion);
    if (existingSubmission.kind === 'matched') {
        return {
            uploadState: existingStatus.lastAsyncUploadState,
            uploadedVersion: existingSubmission.version,
            publishState: existingSubmission.state,
            reconciled: true,
        };
    }
    requireUnusedChromeVersion(existingStatus, normalizedVersion);

    const pollSubmission = async (phase) => {
        const deadline = now() + pollTimeoutMs;
        let lastEvidence = { kind: 'missing' };
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

    let upload;
    try {
        upload = await request(uploadUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
            body: packageBytes,
            phase: 'upload',
            mutates: true,
        });
    } catch (error) {
        if (!error?.outcomeUnknown) throw error;
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

    let uploadState = upload.uploadState;
    const uploadedVersion = upload.crxVersion;
    const uploadDeadline = now() + pollTimeoutMs;
    for (let poll = 0; IN_PROGRESS_STATES.has(uploadState) && poll < maxPolls; poll += 1) {
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

    if (!SUCCESS_STATES.has(uploadState)) {
        throw new Error(`Chrome Web Store upload did not succeed (state: ${uploadState || 'missing'})`);
    }
    if (uploadedVersion && uploadedVersion !== normalizedVersion) {
        throw new Error(
            `Chrome Web Store processed version ${uploadedVersion}; expected ${normalizedVersion}`,
        );
    }

    let publish;
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
        if (!error?.outcomeUnknown) throw error;
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
    if (!SUBMITTED_STATES.has(publish.state)) {
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

async function main() {
    const packagePaths = process.argv.slice(2);
    if (packagePaths.length !== 1) {
        throw new Error('Usage: node scripts/publish-chrome.mjs RELEASE_PACKAGE.zip');
    }

    const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
    const result = await publishChrome({
        token: process.env.CHROME_WEBSTORE_TOKEN,
        publisherId: process.env.CHROME_PUBLISHER_ID,
        extensionId: process.env.CHROME_EXTENSION_ID,
        packageBytes: await readFile(packagePaths[0]),
        expectedVersion: manifest.version,
    });
    console.log(`Submitted Chrome Web Store version ${result.uploadedVersion} for review.`);
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
