// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Streaming text reader with independent encoded-byte and decoded-character
// ceilings. Response bodies are counted after content decoding, so a small or
// dishonest Content-Length cannot hide decompression expansion.

export interface ResourceLimitError extends Error {
    name: 'ResourceLimitError';
    code: 'response-too-large';
    limit: number;
}

export interface ReadAbortError extends Error {
    name: 'AbortError';
    code: 'cancelled';
}

interface BoundedStreamReader {
    read(): Promise<{ done: boolean; value?: unknown }>;
    cancel(): unknown;
    releaseLock(): void;
}

export interface BoundedReadableStream {
    getReader(): BoundedStreamReader;
    cancel?(): unknown;
}

export interface BoundedResponseLike {
    headers?: { get?(name: string): string | null } | null;
    body?: BoundedReadableStream | null;
    text?(): Promise<string>;
}

export interface BoundedBlobLike {
    size?: number;
    stream?(): BoundedReadableStream;
    text?(): Promise<string>;
}

export interface BoundedTextOptions {
    maxBytes: number;
    maxChars?: number;
    signal?: AbortSignal;
    label?: string;
    fatalUtf8?: boolean;
}

export interface BoundedStructureOptions {
    maxDepth: number;
    maxNodes: number;
    maxArrayItems: number;
    maxObjectKeys: number;
    maxStringChars: number;
    label?: string;
}

const limitError = (label: string, limit: number, unit = 'byte'): ResourceLimitError => Object.assign(
    new Error(`${label} exceeds its ${limit}-${unit} limit.`),
    { name: 'ResourceLimitError' as const, code: 'response-too-large' as const, limit },
);

const abortError = (): ReadAbortError => Object.assign(new Error('The read was cancelled.'), {
    name: 'AbortError' as const,
    code: 'cancelled' as const,
});

const byteLength = (text: string): number => {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength;
    if (typeof Blob === 'function') return new Blob([text]).size;
    return unescape(encodeURIComponent(text)).length;
};

export const encodedByteLength = byteLength;

const readStream = async (stream: BoundedReadableStream, {
    maxBytes,
    maxChars,
    signal,
    label,
    fatalUtf8,
}: {
    maxBytes: number;
    maxChars: number;
    signal?: AbortSignal;
    label: string;
    fatalUtf8: boolean;
}): Promise<string> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: fatalUtf8 });
    let bytes = 0;
    let text = '';
    let ended = false, cancelled = false;
    const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        // Cleanup must not mask the read error or wait on a stalled source.
        try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ }
    };
    try {
        if (signal?.aborted) throw abortError();
        signal?.addEventListener('abort', cancel, { once: true });
        while (true) {
            const { done, value } = await reader.read();
            if (signal?.aborted) throw abortError();
            if (done) { ended = true; break; }
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer | ArrayLike<number>);
            bytes += chunk.byteLength;
            if (bytes > maxBytes) throw limitError(label, maxBytes);
            text += decoder.decode(chunk, { stream: true });
            if (text.length > maxChars) throw limitError(label, maxChars);
        }
        text += decoder.decode();
        if (text.length > maxChars) throw limitError(label, maxChars);
        return text;
    } finally {
        signal?.removeEventListener('abort', cancel);
        if (!ended) cancel();
        reader.releaseLock();
    }
};

const validateText = (text: unknown, { maxBytes, maxChars, label }: { maxBytes: number; maxChars: number; label: string }): string => {
    const value = typeof text === 'string' ? text : String(text ?? '');
    if (value.length > maxChars || byteLength(value) > maxBytes) throw limitError(label, maxBytes);
    return value;
};

// JSON.parse itself is bounded by the text ceiling, but callers can still be
// handed a pathologically deep or broad graph. Walk the parsed result before
// any endpoint-specific code touches it so structure cost is explicit too.
export const assertBoundedStructure = <T>(value: T, {
    maxDepth,
    maxNodes,
    maxArrayItems,
    maxObjectKeys,
    maxStringChars,
    label = 'Parsed response',
}: BoundedStructureOptions): T => {
    const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
    let nodes = 0;
    while (stack.length) {
        const current = stack.pop()!;
        nodes += 1;
        if (nodes > maxNodes) throw limitError(label, maxNodes, 'node');
        if (current.depth > maxDepth) throw limitError(label, maxDepth, 'level');
        if (typeof current.value === 'string') {
            if (current.value.length > maxStringChars) {
                throw limitError(label, maxStringChars, 'character');
            }
            continue;
        }
        if (!current.value || typeof current.value !== 'object') continue;
        if (Array.isArray(current.value)) {
            if (current.value.length > maxArrayItems) {
                throw limitError(label, maxArrayItems, 'array-item');
            }
            for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
            continue;
        }
        const entries = Object.entries(current.value);
        if (entries.length > maxObjectKeys) {
            throw limitError(label, maxObjectKeys, 'object-key');
        }
        for (const [key, child] of entries) {
            if (key.length > maxStringChars) throw limitError(label, maxStringChars, 'character');
            stack.push({ value: child, depth: current.depth + 1 });
        }
    }
    return value;
};

export const readBoundedResponseText = async (response: BoundedResponseLike, {
    maxBytes,
    maxChars = maxBytes,
    signal,
    label = 'Response body',
    fatalUtf8 = false,
}: BoundedTextOptions): Promise<string> => {
    const declared = Number(response?.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        try { await response?.body?.cancel?.(); } catch { /* best-effort socket release */ }
        throw limitError(label, maxBytes);
    }
    if (response?.body && typeof response.body.getReader === 'function') {
        return readStream(response.body, { maxBytes, maxChars, signal, label, fatalUtf8 });
    }
    if (signal?.aborted) throw abortError();
    return validateText(await response.text!(), { maxBytes, maxChars, label });
};

export const readBoundedBlobText = async (blob: BoundedBlobLike, {
    maxBytes,
    maxChars = maxBytes,
    signal,
    label = 'File',
    fatalUtf8 = false,
}: BoundedTextOptions): Promise<string> => {
    if (Number.isFinite(blob?.size) && (blob.size as number) > maxBytes) throw limitError(label, maxBytes);
    if (blob?.stream && typeof blob.stream === 'function') {
        return readStream(blob.stream(), { maxBytes, maxChars, signal, label, fatalUtf8 });
    }
    if (signal?.aborted) throw abortError();
    return validateText(await blob.text!(), { maxBytes, maxChars, label });
};

export const boundedText = {
    encodedByteLength,
    readBoundedResponseText,
    readBoundedBlobText,
    assertBoundedStructure,
    isLimitError: (error: unknown): boolean => (error as { name?: unknown } | null | undefined)?.name === 'ResourceLimitError',
};
