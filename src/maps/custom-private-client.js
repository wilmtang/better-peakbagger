// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { RELAY_HOST, readRelayResource } from './custom-overlay-private.js';
export function createPrivateLayerFetch({ send, fallback = globalThis.fetch }) {
    return async (url, options = {}) => {
        if (new URL(url).hostname !== RELAY_HOST) return fallback(url, options);
        const resource = readRelayResource(url);if (!resource) throw new Error('Invalid private map request.');
        const requestId = crypto.randomUUID(), message = { ...resource, requestId };
        let rejectAbort;
        const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
        const abort = () => { void send({ type: 'CUSTOM_PRIVATE_CANCEL', ...message }).catch(() => {});rejectAbort(new DOMException('Cancelled.', 'AbortError')); };
        if (options.signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
        options.signal?.addEventListener('abort', abort, { once: true });
        try {
            const reply = await Promise.race([send({ type: 'CUSTOM_PRIVATE_GET', ...message }), cancelled]);
            if (options.signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
            if (!reply?.ok || typeof reply.bytes !== 'string') throw Object.assign(new Error(reply?.error || 'Private map source unavailable.'), { code: reply?.code || 'private-source', status: reply?.status });
            const text = atob(reply.bytes), bytes = Uint8Array.from(text, char => char.charCodeAt(0));
            return new Response(bytes, { headers: { 'content-type': reply.contentType, 'content-length': String(bytes.length) } });
        } finally { options.signal?.removeEventListener('abort', abort); }
    };
}
export function createPagePrivateFetch(win, fallback = win.fetch.bind(win)) {
    const pending = new Map(), tag = '__bpbCustomOverlays';
    const receive = event => {
        const data = event.data;if (event.source !== win || event.origin !== win.location.origin || !data?.[tag] || data.dir !== 'toPage' || data.type !== 'privateReply') return;
        const item = pending.get(data.requestId);if (item) { pending.delete(data.requestId);win.clearTimeout(item.timer);item.resolve(data.reply); }
    };
    win.addEventListener('message', receive);
    const send = message => {
        if (message.type === 'CUSTOM_PRIVATE_CANCEL') { win.postMessage({ [tag]: true, dir: 'toCS', type: 'privateCancel', message }, win.location.origin);return Promise.resolve(); }
        return new Promise((resolve, reject) => {
            const timer = win.setTimeout(() => { pending.delete(message.requestId);reject(new Error('Private map request timed out.')); }, 20000);
            pending.set(message.requestId, { resolve, reject, timer });win.postMessage({ [tag]: true, dir: 'toCS', type: 'privateGet', message }, win.location.origin);
        });
    };
    return { fetch: createPrivateLayerFetch({ send, fallback }), dispose() {
        win.removeEventListener('message', receive);for (const [requestId, item] of pending) { win.clearTimeout(item.timer);void send({ type: 'CUSTOM_PRIVATE_CANCEL', requestId });item.reject(new DOMException('Cancelled.', 'AbortError')); }pending.clear();
    } };
}
