// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

/* global DataTransfer */

export const ONX_ORIGIN = 'https://backcountry.onxmaps.com';
export const ONX_IMPORT_URL = `${ONX_ORIGIN}/backcountry/map/content/import`;
export const ONX_PERMISSION = Object.freeze({ origins: [`${ONX_ORIGIN}/*`] });
export const MAX_ONX_GPX_BYTES = 4_096_000;
export const ONX_EXPORT_BUDGET_MS = 10_000;
export const ONX_ATTEMPTS_KEY = 'bpbOnxHandoffs';

// Both functions are serialized into the isolated main document. Preflight
// carries no GPX and never clears the document's delivery latch.
export function probeOnxImporter({ attemptId, expiresAt }) {
    const fail = code => ({ ok: false, supplied: false, code, attemptId });
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return fail('expired');
    if (location.origin !== 'https://backcountry.onxmaps.com'
        || location.pathname.toLowerCase() !== '/backcountry/map/content/import') return fail('not-ready');
    const doc = globalThis.document;
    if (doc.querySelector('[data-test="upgrade-now-button"]')) return fail('membership-required');
    if (globalThis.__bpbOnxDocument?.delivered || globalThis.__bpbOnxImportStarted
        || doc.querySelector('[data-test="file-item"]')) return fail('existing-preview');
    const inputs = [...doc.querySelectorAll('#add-files-input[type="file"]')];
    if (!inputs.length || inputs[0].disabled) return fail('not-ready');
    if (inputs.length !== 1 || inputs[0].files.length
        || !inputs[0].accept.toLowerCase().split(',').map(value => value.trim()).includes('.gpx')) {
        return fail('ambiguous-input');
    }
    const state = globalThis.__bpbOnxDocument ||= { nonce: crypto.randomUUID(), delivered: false };
    state.attemptId = attemptId;
    state.expiresAt = expiresAt;
    state.input = inputs[0];
    return { ok: true, supplied: false, code: 'ready', attemptId, documentNonce: state.nonce };
}

// No await occurs before file delivery. A queued invocation cannot initialize
// document identity, wait into a later attempt, or supply after its cutoff.
export async function prepareOnxImport({ gpx, filename, attemptId, documentNonce, expiresAt }) {
    const doc = globalThis.document;
    let supplied = false;
    const result = (ok, code, message) => ({ ok, code, supplied, message, attemptId, documentNonce });
    const fail = code => result(false, code, 'onX’s importer is not ready. No GPX was sent.');
    const state = globalThis.__bpbOnxDocument;
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return fail('expired');
    if (!state || state.nonce !== documentNonce || state.attemptId !== attemptId
        || state.expiresAt !== expiresAt) return fail('document-changed');
    if (location.origin !== 'https://backcountry.onxmaps.com'
        || location.pathname.toLowerCase() !== '/backcountry/map/content/import') return fail('document-changed');
    if (state.delivered || globalThis.__bpbOnxImportStarted || doc.querySelector('[data-test="file-item"]')) {
        return fail('existing-preview');
    }
    if (doc.querySelector('[data-test="upgrade-now-button"]')) return fail('membership-required');
    const inputs = [...doc.querySelectorAll('#add-files-input[type="file"]')];
    if (inputs.length !== 1 || inputs[0] !== state.input || !inputs[0].isConnected
        || inputs[0].disabled || inputs[0].files.length
        || !inputs[0].accept.toLowerCase().split(',').map(value => value.trim()).includes('.gpx')) return fail('ambiguous-input');
    if (typeof gpx !== 'string' || !/^peakbagger-[1-9]\d*\.gpx$/.test(filename || '')
        || new Blob([gpx]).size > 4_096_000) return fail('invalid-payload');
    try {
        const transfer = new DataTransfer();
        transfer.items.add(new File([gpx], filename, { type: 'application/gpx+xml' }));
        if (Date.now() >= expiresAt) return fail('expired');
        // Claim and mutate in the same synchronous turn. A throwing setter is
        // uncertain, so neither this document nor the worker may retry it.
        state.delivered = true;
        globalThis.__bpbOnxImportStarted = true;
        supplied = true;
        inputs[0].files = transfer.files;
        inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        do {
            if (location.origin !== 'https://backcountry.onxmaps.com'
                || location.pathname.toLowerCase() !== '/backcountry/map/content/import') break;
            if (doc.querySelector('[data-test="error-message"]')?.textContent.trim()) break;
            const items = [...doc.querySelectorAll('[data-test="file-item"]')];
            const imports = [...doc.querySelectorAll('[data-test="import-card-import-button"]')];
            if (items.length === 1 && imports.length === 1 && !imports[0].disabled) {
                return result(true, 'prepared', 'Ready in onX. Review the file and click Import.');
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, expiresAt - Date.now()))));
        } while (Date.now() < expiresAt);
    } catch { /* Never persist provider error text or replay a possible delivery. */ }
    return result(false, 'handoff-unconfirmed', 'Check onX before sending again. The file may already be there.');
}
