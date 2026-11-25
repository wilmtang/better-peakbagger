// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { canonicalInstagramUrl } from './instagram-url.ts';
import { instagramEmbedHeight } from './instagram-sizing.ts';
import { settings } from '../settings/settings.ts';

interface InstagramFrameClaimResponse {
    ok?: boolean;
    url?: unknown;
    parentOrigin?: unknown;
}

interface InstagramDisplayStateResponse {
    ok?: boolean;
    allowed?: boolean;
}

interface InstagramRuntimeMessage {
    type?: unknown;
}

interface InstagramMessageSender {
    id?: string;
}

type InstagramMessageListener = (
    message: InstagramRuntimeMessage | null | undefined,
    sender: InstagramMessageSender | null | undefined,
) => void;

interface InstagramFrameExtension {
    runtime: {
        id?: string;
        sendMessage(message: unknown): Promise<unknown>;
        onMessage?: {
            addListener(listener: InstagramMessageListener): void;
            removeListener(listener: InstagramMessageListener): void;
        };
    };
}

const extensionGlobals = globalThis as {
    browser?: InstagramFrameExtension;
    chrome?: InstagramFrameExtension;
};
const api = extensionGlobals.browser || extensionGlobals.chrome;
const token = location.hash.slice(1);
let parentOrigin = '*';
const report = (state: 'loaded' | 'error', height?: number | null): void =>
    parent.postMessage({ __bpbInstagram: state, ...(height !== null && height !== undefined && { height }) }, parentOrigin);

void (async () => {
    try {
        if (!api?.runtime) throw new Error('unavailable');
        const response = await api.runtime.sendMessage({ type: 'INSTAGRAM_FRAME_CLAIM', token }) as InstagramFrameClaimResponse | null | undefined;
        const url = response?.ok && typeof response.url === 'string' ? canonicalInstagramUrl(response.url) : null;
        if (!url || typeof response?.parentOrigin !== 'string' || !response.parentOrigin) throw new Error('unavailable');
        const providerOrigin = new URL(url).origin;
        parentOrigin = response.parentOrigin;
        const frame = document.getElementById('post') as HTMLIFrameElement | null;
        if (!frame) throw new Error('unavailable');
        const scheme = matchMedia('(prefers-color-scheme: dark)');
        let displayRevision = 0;
        let themeRevision = 0;
        let preference = 'system';
        let disposed = false;
        const configureDisplay = async (): Promise<void> => {
            const revision = ++displayRevision;
            let enabled = false;
            try {
                const reply = await api.runtime.sendMessage({ type: 'INSTAGRAM_DISPLAY_STATE' }) as InstagramDisplayStateResponse | null | undefined;
                enabled = reply?.ok === true && reply.allowed === true;
            } catch { /* Native display is still usable. */ }
            if (disposed || revision !== displayRevision) return;
            frame.contentWindow?.postMessage({ __bpbInstagramDisplay: true, enabled, theme: settings.resolveTheme(preference) }, providerOrigin);
        };
        const changed = (): void => { void configureDisplay(); };
        scheme.addEventListener('change', changed);
        const unsubscribe = settings.subscribe(next => { themeRevision++; preference = next.theme; changed(); });
        const initialThemeRevision = themeRevision;
        void settings.requireCurrent().then(next => {
            if (!disposed && initialThemeRevision === themeRevision) { preference = next.theme; changed(); }
        }).catch(() => {});
        const displayChanged: InstagramMessageListener = (message, sender) => {
            if (sender?.id === api.runtime.id && message?.type === 'INSTAGRAM_DISPLAY_CHANGED') changed();
        };
        api.runtime.onMessage?.addListener(displayChanged);
        addEventListener('pagehide', () => {
            disposed = true;
            displayRevision++;
            unsubscribe();
            scheme.removeEventListener('change', changed);
            api.runtime.onMessage?.removeListener(displayChanged);
        }, { once: true });
        let height: number | null = null;
        let reported = false;
        let complete = false;
        let fallback: ReturnType<typeof setTimeout> | undefined;
        const finish = (allowFallback = false): void => {
            if (reported || !complete || (height === null && !allowFallback)) return;
            reported = true;
            clearTimeout(fallback);
            const status = document.getElementById('status');
            if (status) status.hidden = true;
            report('loaded', height);
        };
        addEventListener('message', (event: MessageEvent<unknown>) => {
            // Require both the canonical provider origin and the actual child
            // WindowProxy; another Instagram window cannot resize this post.
            if (event.source !== frame.contentWindow || event.origin !== providerOrigin) return;
            const data = event.data;
            if (data && typeof data === 'object' && (data as { __bpbInstagramProvider?: unknown }).__bpbInstagramProvider === 'ready') {
                void configureDisplay();
                return;
            }
            if (reported || typeof data !== 'string' || data.length > 2048) return;
            try {
                const message = JSON.parse(data) as { type?: unknown; details?: { height?: unknown } } | null;
                if (message?.type === 'MEASURE') {
                    height = instagramEmbedHeight(message.details?.height) ?? height;
                    finish();
                }
            } catch { /* Unknown provider messages never affect layout. */ }
        });
        frame.addEventListener('load', async () => {
            // Complete as soon as the loaded provider has measured its caption.
            // A missing/changed provider protocol falls back once to scrolling;
            // later measurements never bounce the report.
            // The helper's document-start ready message may precede listener
            // delivery in some browsers. Always configure the loaded child too.
            await configureDisplay();
            if (disposed) return;
            complete = true;
            finish();
            if (!reported) fallback = setTimeout(() => finish(true), 1000);
        }, { once: true });
        frame.addEventListener('error', () => report('error'), { once: true });
        // Retain Instagram's own origin so its lazy video-loader requests stay
        // same-origin. The cross-origin provider cannot access this packaged
        // wrapper or Peakbagger, or remove its sandbox. CSP pins frame navigation
        // to Instagram; popups, forms and top navigation remain sandboxed.
        // Give the provider its real width while the parent is still hidden,
        // so its caption-inclusive height is measured at the intended size.
        frame.hidden = false;
        frame.src = `${url}embed/captioned/`;
    } catch {
        const status = document.getElementById('status');
        if (status) status.textContent = 'This post could not be loaded.';
        report('error');
    }
})();
