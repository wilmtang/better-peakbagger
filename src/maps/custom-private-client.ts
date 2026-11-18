// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { RELAY_HOST, readRelayResource, type RelayResource } from './custom-overlay-private.ts';

export type PrivateLayerMessage =
    | ({ type: 'CUSTOM_PRIVATE_GET'; requestId: string } & RelayResource)
    | ({ type: 'CUSTOM_PRIVATE_CANCEL'; requestId: string } & Partial<RelayResource>);

export interface PrivateLayerReply {
    ok?: boolean;
    bytes?: string;
    contentType?: string;
    error?: string;
    code?: string;
    status?: number;
}

export interface PrivateLayerFetchOptions {
    send: (message: PrivateLayerMessage) => Promise<unknown>;
    fallback?: (url: string, options?: RequestInit) => Promise<Response>;
}

interface PendingPrivateRequest {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timer: number;
}

export function createPrivateLayerFetch({ send, fallback = globalThis.fetch }: PrivateLayerFetchOptions) {
    return async (url: string, options: RequestInit = {}): Promise<Response> => {
        if (new URL(url).hostname !== RELAY_HOST) return fallback(url, options);
        const resource = readRelayResource(url);
        if (!resource) throw new Error('Invalid private map request.');
        const requestId = crypto.randomUUID(), message = { ...resource, requestId };
        let rejectAbort!: (reason?: unknown) => void;
        const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
        const abort = () => {
            void send({ type: 'CUSTOM_PRIVATE_CANCEL', ...message }).catch(() => {});
            rejectAbort(new DOMException('Cancelled.', 'AbortError'));
        };
        if (options.signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
        options.signal?.addEventListener('abort', abort, { once: true });
        try {
            const reply = await Promise.race([send({ type: 'CUSTOM_PRIVATE_GET', ...message }), cancelled]);
            if (options.signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
            const replyObj = (reply && typeof reply === 'object' ? reply : null) as PrivateLayerReply | null;
            if (!replyObj?.ok || typeof replyObj.bytes !== 'string') {
                throw Object.assign(
                    new Error(typeof replyObj?.error === 'string' && replyObj.error ? replyObj.error : 'Private map source unavailable.'),
                    { code: typeof replyObj?.code === 'string' && replyObj.code ? replyObj.code : 'private-source', status: replyObj?.status },
                );
            }
            const text = atob(replyObj.bytes), bytes = Uint8Array.from(text, char => char.charCodeAt(0));
            return new Response(bytes, {
                headers: {
                    'content-type': typeof replyObj.contentType === 'string' ? replyObj.contentType : '',
                    'content-length': String(bytes.length),
                },
            });
        } finally {
            options.signal?.removeEventListener('abort', abort);
        }
    };
}

export function createPagePrivateFetch(
    win: Window,
    fallback: (url: string, options?: RequestInit) => Promise<Response> = win.fetch.bind(win),
) {
    const pending = new Map<string, PendingPrivateRequest>(), tag = '__bpbCustomOverlays';
    const receive = (event: MessageEvent) => {
        const data = event.data as Record<string, unknown> | null | undefined;
        if (event.source !== win || event.origin !== win.location.origin || !data?.[tag] || data.dir !== 'toPage' || data.type !== 'privateReply') return;
        const item = typeof data.requestId === 'string' ? pending.get(data.requestId) : undefined;
        if (item) {
            pending.delete(data.requestId as string);
            win.clearTimeout(item.timer);
            item.resolve(data.reply);
        }
    };
    win.addEventListener('message', receive);
    const send = (message: PrivateLayerMessage): Promise<unknown> => {
        if (message.type === 'CUSTOM_PRIVATE_CANCEL') {
            win.postMessage({ [tag]: true, dir: 'toCS', type: 'privateCancel', message }, win.location.origin);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const timer = win.setTimeout(() => {
                pending.delete(message.requestId);
                reject(new Error('Private map request timed out.'));
            }, 20000);
            pending.set(message.requestId, { resolve, reject, timer });
            win.postMessage({ [tag]: true, dir: 'toCS', type: 'privateGet', message }, win.location.origin);
        });
    };
    return {
        fetch: createPrivateLayerFetch({ send, fallback }),
        dispose() {
            win.removeEventListener('message', receive);
            for (const [requestId, item] of pending) {
                win.clearTimeout(item.timer);
                void send({ type: 'CUSTOM_PRIVATE_CANCEL', requestId });
                item.reject(new DOMException('Cancelled.', 'AbortError'));
            }
            pending.clear();
        },
    };
}
