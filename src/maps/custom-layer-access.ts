// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

interface PrivateReviewReply {
    ok?: boolean;
    name?: string;
    origins?: string[];
}

interface PrivateApproveReply {
    ok?: boolean;
    error?: string;
}

const errorMessage = (error: unknown): string =>
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : String(error ?? '');

const api = globalThis.browser || globalThis.chrome;
const token = location.hash.slice(1);
const allow = document.getElementById('allow') as HTMLButtonElement | null;
const status = document.getElementById('status');
const closeButton = document.getElementById('close') as HTMLButtonElement | null;
const sourceName = document.getElementById('source');
const hosts = document.getElementById('hosts');

let origins: string[] = [];
let ready = false;
let busy = false;

if (closeButton) closeButton.onclick = () => window.close();

if (api?.runtime && allow && status) {
    void api.runtime.sendMessage<Record<string, unknown>, PrivateReviewReply | undefined>({
        type: 'CUSTOM_PRIVATE_REVIEW',
        token,
    }).then(reply => {
        if (!reply?.ok || !Array.isArray(reply.origins)) {
            throw new Error('This request expired. Open approval again from the map.');
        }
        origins = reply.origins.map(origin => `https://${new URL(origin).hostname}/*`);
        if (sourceName) sourceName.textContent = reply.name || '';
        if (hosts) hosts.textContent = reply.origins.join(' · ');
        ready = true;
        allow.setAttribute('aria-disabled', 'false');
    }).catch(error => {
        status.textContent = errorMessage(error);
    });

    allow.onclick = async event => {
        if (!event.isTrusted || !ready || busy) return;
        busy = true;
        allow.setAttribute('aria-disabled', 'true');
        allow.setAttribute('aria-busy', 'true');
        status.textContent = 'Waiting for provider access…';
        try {
            // Preserve this explicit extension-surface user activation.
            if (!await api.permissions.request({ origins })) {
                throw new Error('Provider access wasn’t granted. You can try again.');
            }
            const reply = await api.runtime.sendMessage<Record<string, unknown>, PrivateApproveReply | undefined>({
                type: 'CUSTOM_PRIVATE_APPROVE',
                token,
            });
            if (!reply?.ok) throw new Error(reply?.error || 'Approval expired. Open it again from the map.');
            status.textContent = 'Approved. Return to the map and choose Retry.';
            ready = false;
        } catch (error) {
            status.textContent = errorMessage(error);
        } finally {
            busy = false;
            allow.removeAttribute('aria-busy');
            allow.setAttribute('aria-disabled', String(!ready));
        }
    };
}
