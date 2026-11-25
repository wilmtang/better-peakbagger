// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { canonicalInstagramUrl, instagramParagraphUrl } from './instagram-url.ts';
import { instagramEmbedHeight } from './instagram-sizing.ts';
import { createStableText } from '../ui/stable-text.ts';
import { createPageLifecycle } from '../ui/page-lifecycle.ts';
import { trustedAction, type TrustedActionEvent, type TrustedActionExtension } from '../ui/trusted-action.ts';
import { settings } from '../settings/settings.ts';

export type InstagramCardState = 'idle' | 'pending' | 'loaded' | 'error';

export interface InstagramRuntimeSender {
    id?: string;
}

export type InstagramRuntimeMessageListener = (
    message: unknown,
    sender: InstagramRuntimeSender,
    respond: (response: { ok: boolean }) => void,
) => void;

export interface InstagramExtensionApi extends TrustedActionExtension {
    runtime: {
        id?: string;
        getURL(path: string): string;
        sendMessage(message: unknown): Promise<unknown>;
        onMessage: {
            addListener(listener: InstagramRuntimeMessageListener): void;
            removeListener(listener: InstagramRuntimeMessageListener): void;
        };
    };
}

export interface InstagramPreferences {
    subscribe(cb: (settings: { loadInstagramAutomatically?: unknown }) => void): () => void;
    requireCurrent(): Promise<{ loadInstagramAutomatically?: unknown }>;
}

export interface CreateInstagramPresentationOptions {
    doc?: Document;
    ext?: InstagramExtensionApi;
    preferences?: InstagramPreferences;
    timeoutMs?: number;
}

export interface CreateInstagramCardOptions {
    useLink?: ((event: MouseEvent) => void) | null;
}

export interface InstagramCard {
    readonly element: HTMLDivElement;
    readonly url: string;
    onScreen: boolean;
    stop(suppress?: boolean): void;
    refresh(): void;
    destroy(): void;
}

export type InstagramRenderRoot = (Element | DocumentFragment) & {
    moveBefore?: (node: Node, child: Node | null) => void;
};

export interface InstagramPresentation {
    create(raw: unknown, options?: CreateInstagramCardOptions): InstagramCard;
    render(root: InstagramRenderRoot, nodes: Iterable<Node>): void;
    enhance(root: InstagramRenderRoot): void;
    refresh(): void;
    destroy(): void;
}

const IDLE = 'Connects to Instagram';
const PENDING = 'Loading…';
const FAILED = 'Couldn’t load this post';
const NARROW = 'Open link or widen view';
const LOADED = 'Loaded';

const defaultExtension = (): InstagramExtensionApi => {
    const api = (globalThis as { browser?: InstagramExtensionApi; chrome?: InstagramExtensionApi });
    return (api.browser || api.chrome) as InstagramExtensionApi;
};

export function createInstagramPresentation({
    doc = document,
    ext = defaultExtension(),
    preferences = settings,
    timeoutMs = 20_000,
}: CreateInstagramPresentationOptions = {}): InstagramPresentation {
    const defaultView = doc.defaultView;
    if (!defaultView) throw new Error('Document has no defaultView');
    const owner = defaultView;
    const cards = new Set<InstagramCard>(), cardFor = new WeakMap<Node, InstagramCard>(), activeLoads = new Set<string>();
    let automatic = false, settingsRevision = 0, sequence = 0, disposed = false;
    const extensionUrl = new URL(ext.runtime.getURL(''));
    const extensionOrigin = `${extensionUrl.protocol}//${extensionUrl.host}`;
    const element = <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        className?: string,
        text?: string,
    ): HTMLElementTagNameMap[K] => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    };
    const active = (card: InstagramCard): boolean => {
        if (disposed || lifecycle.state !== 'active' || !card.element.isConnected || !card.element.getClientRects().length) return false;
        for (let node: HTMLElement | null = card.element; node; node = node.parentElement) {
            const style = owner.getComputedStyle(node);
            if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return true;
    };
    const handleSource: InstagramRuntimeMessageListener = (message, sender, respond) => {
        if (!message || typeof message !== 'object') return;
        const payload = message as { type?: unknown; nonce?: unknown };
        if (payload.type !== 'INSTAGRAM_FRAME_SOURCE_CURRENT') return;
        respond({
            ok: sender.id === ext.runtime.id
                && typeof payload.nonce === 'string'
                && activeLoads.has(payload.nonce)
                && !disposed
                && lifecycle.state === 'active',
        });
    };
    ext.runtime.onMessage.addListener(handleSource);
    const lifecycle = createPageLifecycle({
        ownerWindow: owner,
        onSuspend: () => cards.forEach(card => card.stop(false)),
        onResume: () => cards.forEach(card => card.refresh()),
        onDispose: () => dispose(),
    });
    const updatePreference = (next: { loadInstagramAutomatically?: unknown }) => {
        const value = next.loadInstagramAutomatically === true;
        if (value === automatic) return;
        automatic = value;
        for (const card of cards) { card.stop(false); card.refresh(); }
    };
    const unsubscribe = preferences.subscribe(next => { settingsRevision++; updatePreference(next); });
    const initialRevision = settingsRevision;
    preferences.requireCurrent().then(next => { if (!disposed && initialRevision === settingsRevision) updatePreference(next); }).catch(() => {});
    const visibility = new owner.MutationObserver(records => {
        for (const card of [...cards]) {
            if (!card.element.isConnected) { card.destroy(); continue; }
            if (records.some(record => record.target.contains(card.element))) card.refresh();
        }
    });
    visibility.observe(doc, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'style'] });
    const intersections = typeof owner.IntersectionObserver === 'function' ? new owner.IntersectionObserver(entries => {
        for (const entry of entries) { const card = cardFor.get(entry.target); if (card) { card.onScreen = entry.isIntersecting; card.refresh(); } }
    }) : null;
    const resize = typeof owner.ResizeObserver === 'function' ? new owner.ResizeObserver(entries => {
        for (const entry of entries) cardFor.get(entry.target)?.refresh();
    }) : null;

    function create(raw: unknown, { useLink }: CreateInstagramCardOptions = {}): InstagramCard {
        const url = canonicalInstagramUrl(raw); if (!url) throw new Error('Invalid Instagram post');
        const box = element('div', 'bpb-instagram'); box.contentEditable = 'false';
        const toolbar = element('div', 'bpb-instagram-toolbar');
        const link = element('a', 'bpb-instagram-link bpb-instagram-title', 'Instagram'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', 'Open post on Instagram');
        const arrow = element('span', 'bpb-instagram-external', '↗'); arrow.setAttribute('aria-hidden', 'true'); link.append(arrow);
        const status = element('span', 'bpb-instagram-status', IDLE); status.setAttribute('role', 'status');
        const text = createStableText(status); text.reserve([IDLE, PENDING, FAILED, NARROW, LOADED]);
        const actions = element('div', 'bpb-instagram-actions');
        const button = element('button', 'bpb-instagram-action', 'Load post'); button.type = 'button'; button.dataset.bpbReportMediaUi = '';
        const label = createStableText(button); label.reserve(['Load post', 'Cancel', 'Hide post', 'Retry']);
        actions.append(button);
        if (useLink) {
            const convert = element('button', 'bpb-instagram-as-link', 'Use link');
            convert.type = 'button'; convert.dataset.bpbReportMediaUi = ''; convert.addEventListener('click', useLink); actions.append(convert);
        }
        const media = element('div', 'bpb-instagram-media'); media.hidden = true; media.setAttribute('inert', ''); media.setAttribute('aria-hidden', 'true');
        toolbar.append(link, actions, status); box.append(toolbar, media);
        let state: InstagramCardState = 'idle';
        let generation = 0;
        let frame: HTMLIFrameElement | null = null;
        let timer: number | null = null;
        let nonce: string | null = null;
        let suppressed = false;
        let dead = false;
        const clearTimer = () => { if (timer !== null) { owner.clearTimeout(timer); timer = null; } };
        const paint = () => {
            label.set(state === 'pending' ? 'Cancel' : state === 'loaded' ? 'Hide post' : state === 'error' ? 'Retry' : 'Load post');
            button.setAttribute('aria-label', state === 'pending' ? 'Cancel loading Instagram post' : state === 'loaded' ? 'Hide Instagram post' : state === 'error' ? 'Retry loading Instagram post' : 'Load Instagram post');
            box.dataset.state = state;
        };
        const stop = (suppress = true) => {
            generation++;
            if (nonce !== null) activeLoads.delete(nonce);
            nonce = null; clearTimer(); frame?.remove(); frame = null; media.hidden = true; media.style.height = '';
            media.setAttribute('inert', ''); media.setAttribute('aria-hidden', 'true'); delete media.dataset.pending;
            state = 'idle'; suppressed = suppress; text.set(IDLE); paint();
        };
        const fail = () => { stop(true); state = 'error'; text.set(FAILED); paint(); };
        const load = async (event: TrustedActionEvent | null, auto = false) => {
            if (dead || state === 'pending' || state === 'loaded' || !active(card) || (!auto && event?.isTrusted !== true)) return;
            if (box.clientWidth < 320) { text.set(NARROW); return; }
            suppressed = false; const revision = ++generation; state = 'pending'; text.set(PENDING); paint();
            const sourceNonce = owner.crypto.randomUUID(); nonce = sourceNonce; activeLoads.add(sourceNonce);
            timer = owner.setTimeout(() => { if (revision === generation) fail(); }, timeoutMs);
            try {
                const actionGeneration = `instagram-${++sequence}`;
                let payload: Record<string, unknown>;
                if (auto) {
                    payload = { type: 'INSTAGRAM_FRAME_ISSUE', url, sourceNonce, automatic: true };
                } else {
                    const activation = await trustedAction.issue(ext, event, 'instagram-post', actionGeneration);
                    if (!activation) throw new Error('activation');
                    payload = {
                        type: 'INSTAGRAM_FRAME_ISSUE', url, sourceNonce, automatic: false,
                        generation: actionGeneration, activationToken: activation.token,
                    };
                }
                const response = await ext.runtime.sendMessage(payload) as { ok?: unknown; token?: unknown } | null | undefined;
                if (dead || revision !== generation || !active(card)) return;
                if (!response?.ok || typeof response.token !== 'string' || !/^[a-f0-9]{48}$/.test(response.token)) throw new Error('unavailable');
                frame = element('iframe', 'bpb-instagram-frame'); frame.title = 'Instagram post'; frame.referrerPolicy = 'no-referrer'; frame.tabIndex = -1;
                frame.src = ext.runtime.getURL('reports/instagram.html') + '#' + response.token;
                media.dataset.pending = ''; media.hidden = false; media.append(frame);
            } catch { if (!dead && revision === generation) fail(); }
        };
        button.addEventListener('click', event => { if (event.isTrusted !== true) return; if (state === 'pending' || state === 'loaded') stop(); else void load(event); });
        const receive = (event: MessageEvent<unknown>) => {
            if (!frame || event.source !== frame.contentWindow || event.origin !== extensionOrigin || state !== 'pending') return;
            const data = event.data;
            if (!data || typeof data !== 'object') return;
            const payload = data as { __bpbInstagram?: unknown; height?: unknown };
            if (payload.__bpbInstagram === 'error') { fail(); return; }
            if (payload.__bpbInstagram !== 'loaded') return;
            const height = instagramEmbedHeight(payload.height);
            if (height !== null) media.style.height = `${height}px`;
            clearTimer(); state = 'loaded'; delete media.dataset.pending; media.removeAttribute('inert'); media.removeAttribute('aria-hidden'); frame.tabIndex = 0; text.set(LOADED); paint();
        };
        owner.addEventListener('message', receive);
        const card: InstagramCard = {
            element: box, url, onScreen: !intersections, stop,
            refresh: () => {
                if (dead) return;
                if (!active(card)) { if (state === 'pending' || state === 'loaded') stop(false); return; }
                if (automatic && card.onScreen && !suppressed && state === 'idle') void load(null, true);
            },
            destroy: () => {
                if (dead) return;
                dead = true; stop(); owner.removeEventListener('message', receive);
                intersections?.unobserve(box); resize?.unobserve(box); cards.delete(card); cardFor.delete(box);
            },
        };
        cards.add(card); cardFor.set(box, card); intersections?.observe(box); resize?.observe(box);
        paint();
        owner.requestAnimationFrame?.(() => card.refresh());
        return card;
    }

    function render(root: InstagramRenderRoot, nodes: Iterable<Node>): void {
        const reusable = new Map<string, InstagramCard[]>();
        for (const child of root.children) {
            const card = cardFor.get(child);
            if (card) { const group = reusable.get(card.url) || []; group.push(card); reusable.set(card.url, group); }
        }
        const desired = [...nodes].map(node => {
            const url = instagramParagraphUrl(node); if (!url) return node;
            return (reusable.get(url)?.shift() || create(url)).element;
        });
        for (const group of reusable.values()) for (const card of group) card.destroy();
        // Remove obsolete prose first. An unchanged post then stays connected
        // even on Chrome versions without state-preserving moveBefore().
        const retained = new Set<Node>(desired);
        for (const node of [...root.childNodes]) if (!retained.has(node)) node.remove();
        let anchor = root.firstChild;
        for (const node of desired) {
            if (node !== anchor) {
                if (node.parentElement === root && typeof root.moveBefore === 'function' && node.isConnected) root.moveBefore(node, anchor);
                else { if (node.parentElement === root) cardFor.get(node)?.stop(); root.insertBefore(node, anchor); }
            }
            anchor = node.nextSibling;
        }
        while (anchor) { const next = anchor.nextSibling; anchor.remove(); anchor = next; }
        for (const card of cards) if (root.contains(card.element)) card.refresh();
    }
    function dispose(): void {
        if (disposed) return; disposed = true; unsubscribe(); visibility.disconnect(); intersections?.disconnect(); resize?.disconnect();
        ext.runtime.onMessage.removeListener(handleSource); for (const card of [...cards]) card.destroy(); lifecycle.dispose();
    }
    return { create, render, enhance: root => render(root, [...root.childNodes]), refresh: () => cards.forEach(card => card.refresh()), destroy: dispose };
}
