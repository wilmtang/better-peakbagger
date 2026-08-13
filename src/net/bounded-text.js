// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Streaming text reader with independent encoded-byte and decoded-character
// ceilings. Response bodies are counted after content decoding, so a small or
// dishonest Content-Length cannot hide decompression expansion.

const limitError = (label, limit, unit = 'byte') => Object.assign(
    new Error(`${label} exceeds its ${limit}-${unit} limit.`),
    { name: 'ResourceLimitError', code: 'response-too-large', limit },
);

const abortError = () => Object.assign(new Error('The read was cancelled.'), {
    name: 'AbortError',
    code: 'cancelled',
});

const byteLength = text => {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength;
    if (typeof Blob === 'function') return new Blob([text]).size;
    return unescape(encodeURIComponent(text)).length;
};

const readStream = async (stream, {
    maxBytes,
    maxChars,
    signal,
    label,
}) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    const cancel = () => { void reader.cancel().catch(() => {}); };
    if (signal?.aborted) {
        cancel();
        throw abortError();
    }
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (signal?.aborted) throw abortError();
            if (done) break;
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
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
        if (bytes > maxBytes || text.length > maxChars || signal?.aborted) cancel();
        else reader.releaseLock();
    }
};

const validateText = (text, { maxBytes, maxChars, label }) => {
    const value = typeof text === 'string' ? text : String(text ?? '');
    if (value.length > maxChars || byteLength(value) > maxBytes) throw limitError(label, maxBytes);
    return value;
};

// JSON.parse itself is bounded by the text ceiling, but callers can still be
// handed a pathologically deep or broad graph. Walk the parsed result before
// any endpoint-specific code touches it so structure cost is explicit too.
export const assertBoundedStructure = (value, {
    maxDepth,
    maxNodes,
    maxArrayItems,
    maxObjectKeys,
    maxStringChars,
    label = 'Parsed response',
}) => {
    const stack = [{ value, depth: 0 }];
    let nodes = 0;
    while (stack.length) {
        const current = stack.pop();
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

export const readBoundedResponseText = async (response, {
    maxBytes,
    maxChars = maxBytes,
    signal,
    label = 'Response body',
}) => {
    const declared = Number(response?.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        try { await response?.body?.cancel?.(); } catch { /* best-effort socket release */ }
        throw limitError(label, maxBytes);
    }
    if (response?.body && typeof response.body.getReader === 'function') {
        return readStream(response.body, { maxBytes, maxChars, signal, label });
    }
    if (signal?.aborted) throw abortError();
    return validateText(await response.text(), { maxBytes, maxChars, label });
};

export const readBoundedBlobText = async (blob, {
    maxBytes,
    maxChars = maxBytes,
    signal,
    label = 'File',
}) => {
    if (Number.isFinite(blob?.size) && blob.size > maxBytes) throw limitError(label, maxBytes);
    if (blob?.stream && typeof blob.stream === 'function') {
        return readStream(blob.stream(), { maxBytes, maxChars, signal, label });
    }
    if (signal?.aborted) throw abortError();
    return validateText(await blob.text(), { maxBytes, maxChars, label });
};

export const boundedText = {
    readBoundedResponseText,
    readBoundedBlobText,
    assertBoundedStructure,
    isLimitError: error => error?.name === 'ResourceLimitError',
    isAbortError: error => error?.name === 'AbortError',
};
