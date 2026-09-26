// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

/* global DataTransfer */

export const CALTOPO_ORIGIN = 'https://caltopo.com';
export const CALTOPO_IMPORT_URL = `${CALTOPO_ORIGIN}/map.html`;
export const CALTOPO_PERMISSION = Object.freeze({ origins: [`${CALTOPO_ORIGIN}/*`] });
// Extension memory/transfer budget, not a claim about CalTopo's service limit.
export const MAX_CALTOPO_GPX_BYTES = 15 * 1024 * 1024;

// Serialized into the isolated world. File selection invokes CalTopo's own
// parser; the later Import Data confirmation and map Save remain manual.
export async function prepareCaltopoImport({ gpx, filename, timeoutMs = 20_000 }) {
    const doc = globalThis.document;
    const view = globalThis.window;
    let supplied = false;
    const fail = (code, message) => ({ ok: false, code, supplied, message });
    if (view.location.origin !== 'https://caltopo.com'
        || view.location.pathname !== '/map.html' || view.location.search) {
        return fail('wrong-page', 'CalTopo did not stay on its blank map. Import this GPX manually.');
    }
    if (typeof gpx !== 'string' || !/^peakbagger-[1-9]\d*\.gpx$/.test(filename || '')
        || new Blob([gpx]).size > 15 * 1024 * 1024) {
        return fail('invalid-payload', 'The GPX transfer is invalid or exceeds the extension’s 15 MiB transfer limit.');
    }
    const visible = element => element?.getClientRects().length > 0
        && view.getComputedStyle(element).visibility !== 'hidden';
    const panels = title => [...doc.querySelectorAll('.yui-panel')].filter(panel =>
        visible(panel) && panel.querySelector('.hd')?.textContent.trim() === title);
    const wait = async (read, description) => {
        const deadline = Date.now() + Math.min(30_000, Math.max(100, timeoutMs));
        do {
            const value = read();
            if (value) return value;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        throw new Error(`CalTopo did not show ${description} before the timeout.`);
    };
    try {
        if (panels('Importer').length || panels('Import Data').length) {
            return fail('existing-preview', 'This CalTopo tab already has an import to review.');
        }
        if (globalThis.__bpbCaltopoImportStarted) {
            return fail('already-started', 'This CalTopo tab already received an import attempt.');
        }
        const openers = await wait(() => {
            const found = [...doc.querySelectorAll('#page_left .action-button-js')].filter(element =>
                visible(element) && element.textContent.trim() === 'Import'
                && element.querySelector('img[src="/static/images/import.svg"]'));
            return found.length ? found : null;
        }, 'its map Import control');
        if (openers.length !== 1) return fail('ambiguous-importer', 'CalTopo’s importer changed or is unavailable.');
        openers[0].click();
        const inputs = await wait(() => {
            const dialogs = panels('Importer');
            if (dialogs.length !== 1) return null;
            const found = [...dialogs[0].querySelectorAll('input[type="file"]')];
            return found.length ? found : null;
        }, 'its import file control');
        if (inputs.length !== 1 || inputs[0].id !== 'file' || inputs[0].disabled || inputs[0].files.length) {
            return fail('ambiguous-input', 'CalTopo’s file importer changed or already contains a file.');
        }
        globalThis.__bpbCaltopoImportStarted = true;
        const transfer = new DataTransfer();
        transfer.items.add(new File([gpx], filename, { type: 'application/gpx+xml' }));
        inputs[0].files = transfer.files;
        supplied = true;
        inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        await wait(() => {
            const dialogs = panels('Import Data');
            if (dialogs.length !== 1) return null;
            const dialog = dialogs[0];
            const objects = [...dialog.querySelectorAll('tbody tr')].filter(row =>
                row.querySelector('input[type="checkbox"]') && row.querySelector('input[type="text"]'));
            const confirm = [...dialog.querySelectorAll('button')].filter(button =>
                visible(button) && button.textContent.trim() === 'Import');
            return objects.length && confirm.length === 1 && !confirm[0].disabled;
        }, 'the objects ready to import');
        return { ok: true, supplied, code: 'prepared',
            message: 'Ready in CalTopo. Review the objects and click Import.' };
    } catch (error) {
        return fail(supplied ? 'handoff-unconfirmed' : 'importer-unavailable',
            supplied ? `${error.message} Check this CalTopo tab before sending again.` : error.message);
    }
}
