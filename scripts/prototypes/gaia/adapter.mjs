// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global DataTransfer */

// Serialized by scripting.executeScript into Gaia's isolated world. Keep every
// dependency inside this function. Selectors were inspected in Gaia's public
// ImportSidebar bundle on 2026-09-14; no private API or framework store is used.
export async function prepareGaiaImport({ gpx, filename, timeoutMs = 20_000 }) {
    const doc = globalThis.document;
    const view = globalThis.window;
    let supplied = false;
    const fail = (code, message) => ({ ok: false, code, supplied, message });
    if (view.location.origin !== 'https://www.gaiagps.com' || view.location.pathname !== '/map/') {
        return fail('wrong-page', 'Open the Gaia GPS map to import this track.');
    }
    if (typeof gpx !== 'string' || !/^peakbagger-[1-9]\d*\.gpx$/.test(filename || '')
        || new Blob([gpx]).size > 4 * 1024 * 1024) {
        return fail('invalid-payload', 'The GPX transfer is invalid or too large.');
    }
    // One transfer per newly created document; never retry a file handoff whose
    // outcome is unknown. This marker lives only in the extension's world.
    if (globalThis.__bpbGaiaImportStarted) return fail('already-started', 'This Gaia tab already received an import attempt.');
    globalThis.__bpbGaiaImportStarted = true;
    const visible = element => element?.getClientRects().length > 0
        && view.getComputedStyle(element).visibility !== 'hidden';
    const buttons = () => [...doc.querySelectorAll('button')].filter(visible);
    const saves = () => buttons().filter(button => /^Save\s+[\d,]+\s+items?$/i.test(button.textContent.trim()));
    const wait = async (read, description) => {
        const deadline = Date.now() + Math.min(30_000, Math.max(100, timeoutMs));
        let last;
        do {
            last = read();
            if (last) return last;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        throw new Error(`Gaia did not show ${description} before the timeout.`);
    };
    try {
        const imports = await wait(() => {
            const candidates = [...doc.querySelectorAll('button[aria-label="Import Data"]')].filter(visible);
            return candidates.length ? candidates : null;
        }, 'its Import Data control');
        if (imports.length !== 1) return fail('ambiguous-importer', 'Gaia has multiple import controls. Import this file manually.');
        if (imports[0].disabled) {
            const signedOut = buttons().some(button => /^Log In$/i.test(button.textContent.trim()));
            if (signedOut) return fail('sign-in-required', 'Sign into Gaia in this browser, then return to the ascent and try again.');
            // The import button can appear before the account request finishes.
            await wait(() => !imports[0].disabled || buttons().some(button => /^Log In$/i.test(button.textContent.trim())), 'an available importer');
            if (imports[0].disabled) return fail('sign-in-required', 'Sign into Gaia in this browser, then return to the ascent and try again.');
        }
        if (saves().length) return fail('existing-preview', 'This Gaia tab already has an import to review.');
        imports[0].click();
        const inputs = await wait(() => {
            const candidates = [...doc.querySelectorAll('input[type="file"][placeholder="Drag and drop to import files"]')];
            return candidates.length ? candidates : null;
        }, 'its file importer');
        if (inputs.length !== 1 || inputs[0].files.length || inputs[0].disabled
            || !inputs[0].accept.toLowerCase().split(',').map(value => value.trim()).includes('.gpx')) {
            return fail('ambiguous-input', 'Gaia’s file importer changed or already contains a file.');
        }
        const transfer = new DataTransfer();
        transfer.items.add(new File([gpx], filename, { type: 'application/gpx+xml' }));
        inputs[0].files = transfer.files;
        // Gaia's current React importer listens to onInput, not onChange.
        supplied = true;
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        await wait(() => {
            if (/^Import Error$/im.test(doc.body.innerText)) throw new Error('Gaia reported an import error.');
            const ready = saves();
            return ready.length === 1 && !ready[0].disabled && !/^Save\s+0\s+items?$/i.test(ready[0].textContent.trim());
        }, 'items ready to save');
        return { ok: true, supplied, code: 'prepared', message: 'GPX ready in Gaia. Review the items and click Gaia’s Save button.' };
    } catch (error) {
        return fail(supplied ? 'handoff-unconfirmed' : 'importer-unavailable', supplied
            ? `${error.message} The file was supplied. Check this Gaia tab before sending again; saving was not verified.`
            : error.message);
    }
}
