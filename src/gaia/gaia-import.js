// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

/* global DataTransfer */

export const GAIA_ORIGIN = 'https://www.gaiagps.com';
export const GAIA_MAP_URL = `${GAIA_ORIGIN}/map/`;
export const GAIA_PERMISSION = Object.freeze({ origins: [`${GAIA_ORIGIN}/*`] });
export const MAX_GAIA_GPX_BYTES = 15 * 1024 * 1024;

// Serialized by scripting.executeScript into Gaia's isolated world. Keep every
// dependency inside this function. It uses only the visible importer UI and
// deliberately leaves Gaia's Save action to the user.
export async function prepareGaiaImport({ gpx, filename, timeoutMs = 20_000 }) {
    const doc = globalThis.document;
    const view = globalThis.window;
    let supplied = false;
    const fail = (code, message) => ({ ok: false, code, supplied, message });

    if (view.location.origin !== 'https://www.gaiagps.com' || view.location.pathname !== '/map/') {
        return fail('wrong-page', 'Gaia did not stay on its map. Import this GPX manually.');
    }
    if (typeof gpx !== 'string' || !/^peakbagger-[1-9]\d*\.gpx$/.test(filename || '')
        || new Blob([gpx]).size > 15 * 1024 * 1024) {
        return fail('invalid-payload', 'The GPX transfer is invalid or too large.');
    }

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
        if (imports.length !== 1) {
            return fail('ambiguous-importer', 'Gaia has multiple import controls. Import this GPX manually.');
        }
        if (imports[0].disabled) {
            const signedOut = buttons().some(button => /^Log In$/i.test(button.textContent.trim()));
            if (signedOut) {
                return fail('sign-in-required', 'Sign in to Gaia, then return here and try again.');
            }
            await wait(
                () => !imports[0].disabled || buttons().some(button => /^Log In$/i.test(button.textContent.trim())),
                'an available importer',
            );
            if (imports[0].disabled) {
                return fail('sign-in-required', 'Sign in to Gaia, then return here and try again.');
            }
        }
        if (saves().length) {
            return fail('existing-preview', 'This Gaia tab already has an import to review.');
        }
        if (globalThis.__bpbGaiaImportStarted) {
            return fail('already-started', 'This Gaia tab already received an import attempt.');
        }

        imports[0].click();
        const inputs = await wait(() => {
            const candidates = [...doc.querySelectorAll(
                'input[type="file"][placeholder="Drag and drop to import files"]',
            )];
            return candidates.length ? candidates : null;
        }, 'its file importer');
        if (inputs.length !== 1 || inputs[0].files.length || inputs[0].disabled
            || !inputs[0].accept.toLowerCase().split(',').map(value => value.trim()).includes('.gpx')) {
            return fail('ambiguous-input', 'Gaia’s file importer changed or already contains a file.');
        }

        // One handoff per document. Set the marker only when the file is about
        // to cross the boundary, so a signed-out tab remains safe to reuse.
        globalThis.__bpbGaiaImportStarted = true;
        const transfer = new DataTransfer();
        transfer.items.add(new File([gpx], filename, { type: 'application/gpx+xml' }));
        inputs[0].files = transfer.files;
        supplied = true;
        // Gaia's current React importer listens to onInput, not onChange.
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        await wait(() => {
            if (/^Import Error$/im.test(doc.body.innerText)) throw new Error('Gaia reported an import error.');
            const ready = saves();
            return ready.length === 1 && !ready[0].disabled
                && !/^Save\s+0\s+items?$/i.test(ready[0].textContent.trim());
        }, 'items ready to save');
        return {
            ok: true,
            supplied,
            code: 'prepared',
            message: 'Ready in Gaia. Review the items and click Save.',
        };
    } catch (error) {
        return fail(
            supplied ? 'handoff-unconfirmed' : 'importer-unavailable',
            supplied
                ? `${error.message} Check this Gaia tab before sending again.`
                : error.message,
        );
    }
}

export const gaiaImport = {
    GAIA_ORIGIN,
    GAIA_MAP_URL,
    GAIA_PERMISSION,
    MAX_GAIA_GPX_BYTES,
    prepareGaiaImport,
};
