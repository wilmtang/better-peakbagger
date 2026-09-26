// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

/* global DataTransfer */

export const ALLTRAILS_ORIGIN = 'https://www.alltrails.com';
export const ALLTRAILS_IMPORT_URL = `${ALLTRAILS_ORIGIN}/explore/custom-routes/new`;
export const ALLTRAILS_PERMISSION = Object.freeze({ origins: [`${ALLTRAILS_ORIGIN}/*`] });
// AllTrails publishes a 20 MB limit; use decimal bytes to avoid handing it a
// file above that limit when the service interprets MB in its usual form.
export const MAX_ALLTRAILS_GPX_BYTES = 20_000_000;

// Serialized by scripting.executeScript into the AllTrails tab's isolated
// world. It selects the file in AllTrails' visible route uploader and leaves
// the final Upload action to the user.
export async function prepareAlltrailsImport({ gpx, filename, timeoutMs = 20_000 }) {
    const doc = globalThis.document;
    const view = globalThis.window;
    let supplied = false;
    const fail = (code, message) => ({ ok: false, code, supplied, message });

    if (view.location.origin !== 'https://www.alltrails.com'
        || view.location.pathname.replace(/\/+$/, '') !== '/explore/custom-routes/new') {
        return fail('wrong-page', 'AllTrails did not stay on its custom route builder. Import this GPX manually.');
    }
    if (typeof gpx !== 'string' || !/^peakbagger-[1-9]\d*\.gpx$/.test(filename || '')
        || new Blob([gpx]).size > 20_000_000) {
        return fail('invalid-payload', 'The GPX transfer is invalid or larger than AllTrails’ 20 MB limit.');
    }

    const visible = element => element?.getClientRects().length > 0
        && view.getComputedStyle(element).visibility !== 'hidden';
    const exactButtons = (root, label) => [...root.querySelectorAll('button')]
        .filter(button => visible(button) && button.textContent.trim() === label);
    const uploadDialogs = () => [...doc.querySelectorAll('[role="dialog"]')].filter(dialog => {
        if (!visible(dialog)) return false;
        const headings = [...dialog.querySelectorAll('h1, h2, h3')];
        return headings.some(heading => heading.textContent.trim() === 'Upload a route');
    });
    const wait = async (read, description) => {
        const deadline = Date.now() + Math.min(30_000, Math.max(100, timeoutMs));
        let last;
        do {
            last = read();
            if (last) return last;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        throw new Error(`AllTrails did not show ${description} before the timeout.`);
    };

    try {
        if (uploadDialogs().length) {
            return fail('existing-preview', 'This AllTrails tab already has an upload to review.');
        }
        if (globalThis.__bpbAlltrailsImportStarted) {
            return fail('already-started', 'This AllTrails tab already received an import attempt.');
        }

        const openers = await wait(() => {
            const candidates = exactButtons(doc, 'Upload a route');
            return candidates.length ? candidates : null;
        }, 'its Upload a route control');
        if (openers.length !== 1 || openers[0].disabled) {
            return fail('ambiguous-importer', 'AllTrails’ route uploader changed or is unavailable.');
        }
        openers[0].click();

        const inputs = await wait(() => {
            const candidates = uploadDialogs();
            if (candidates.length !== 1) return null;
            // The dialog can mount before its file control. Its accessibility
            // label is presentation copy, not an importer identifier; scope to
            // the route dialog and validate the GPX input below instead.
            const files = [...candidates[0].querySelectorAll('input[type="file"]')];
            return files.length ? files : null;
        }, 'its route upload file control');
        const accepts = inputs[0]?.accept.toLowerCase().split(',').map(value => value.trim()) || [];
        if (inputs.length !== 1 || inputs[0].files.length || inputs[0].disabled || !accepts.includes('.gpx')) {
            return fail('ambiguous-input', 'AllTrails’ file uploader changed or already contains a file.');
        }

        globalThis.__bpbAlltrailsImportStarted = true;
        const transfer = new DataTransfer();
        transfer.items.add(new File([gpx], filename, { type: 'application/gpx+xml' }));
        inputs[0].files = transfer.files;
        supplied = true;
        inputs[0].dispatchEvent(new Event('change', { bubbles: true }));

        await wait(() => {
            const dialogs = uploadDialogs();
            if (dialogs.length !== 1) return null;
            const current = dialogs[0];
            const alert = [...current.querySelectorAll('[role="alert"]')]
                .find(element => element.textContent.trim());
            if (alert) throw new Error(`AllTrails reported: ${alert.textContent.trim()}`);
            const filenameShown = [...current.querySelectorAll('[title]')]
                .some(element => element.getAttribute('title') === filename);
            const uploads = exactButtons(current, 'Upload');
            return filenameShown && uploads.length === 1 && !uploads[0].disabled;
        }, 'the route ready to upload');

        return {
            ok: true,
            supplied,
            code: 'prepared',
            message: 'Ready in AllTrails. Review the route and click Upload.',
        };
    } catch (error) {
        return fail(
            supplied ? 'handoff-unconfirmed' : 'importer-unavailable',
            supplied
                ? `${error.message} Check this AllTrails tab before sending again.`
                : error.message,
        );
    }
}

export const alltrailsImport = {
    ALLTRAILS_ORIGIN,
    ALLTRAILS_IMPORT_URL,
    ALLTRAILS_PERMISSION,
    MAX_ALLTRAILS_GPX_BYTES,
    prepareAlltrailsImport,
};
