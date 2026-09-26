// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

/* global DataTransfer */

export const ONX_ORIGIN = 'https://backcountry.onxmaps.com';
export const ONX_IMPORT_URL = `${ONX_ORIGIN}/backcountry/map/content/import`;
export const ONX_PERMISSION = Object.freeze({ origins: [`${ONX_ORIGIN}/*`] });
// onX documents a 4 MB limit and currently enforces 4,096,000 bytes.
export const MAX_ONX_GPX_BYTES = 4_096_000;

// Serialized by scripting.executeScript into the onX tab's isolated world.
// It supplies the file through onX's visible importer and leaves the final
// Import action to the user.
export async function prepareOnxImport({ gpx, filename, timeoutMs = 20_000 }) {
    const doc = globalThis.document;
    const view = globalThis.window;
    let supplied = false;
    const fail = (code, message) => ({ ok: false, code, supplied, message });

    if (view.location.origin !== 'https://backcountry.onxmaps.com'
        || view.location.pathname.toLowerCase() !== '/backcountry/map/content/import') {
        return fail('wrong-page', 'onX did not stay on its Backcountry import page. Import this GPX manually.');
    }
    if (typeof gpx !== 'string' || !/^peakbagger-[1-9]\d*\.gpx$/.test(filename || '')
        || new Blob([gpx]).size > 4_096_000) {
        return fail('invalid-payload', 'The GPX transfer is invalid or larger than onX’s 4 MB limit.');
    }

    const wait = async (read, description) => {
        const deadline = Date.now() + Math.min(30_000, Math.max(100, timeoutMs));
        let last;
        do {
            last = read();
            if (last) return last;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        throw new Error(`onX did not show ${description} before the timeout.`);
    };

    try {
        if (doc.querySelector('[data-test="upgrade-now-button"]')) {
            return fail(
                'membership-required',
                'onX GPX import requires a Premium or Elite membership. Upgrade or import this GPX elsewhere.',
            );
        }
        if (doc.querySelector('[data-test="file-item"]')) {
            return fail('existing-preview', 'This onX tab already has a file to review.');
        }
        if (globalThis.__bpbOnxImportStarted) {
            return fail('already-started', 'This onX tab already received an import attempt.');
        }

        const inputs = await wait(() => {
            if (doc.querySelector('[data-test="upgrade-now-button"]')) return { membershipRequired: true };
            const candidates = [...doc.querySelectorAll('#add-files-input[type="file"]')];
            return candidates.length ? candidates : null;
        }, 'its file importer');
        if (inputs.membershipRequired) {
            return fail(
                'membership-required',
                'onX GPX import requires a Premium or Elite membership. Upgrade or import this GPX elsewhere.',
            );
        }
        if (inputs.length !== 1 || inputs[0].files.length || inputs[0].disabled
            || !inputs[0].accept.toLowerCase().split(',').map(value => value.trim()).includes('.gpx')) {
            return fail('ambiguous-input', 'onX’s file importer changed or already contains a file.');
        }

        globalThis.__bpbOnxImportStarted = true;
        const transfer = new DataTransfer();
        transfer.items.add(new File([gpx], filename, { type: 'application/gpx+xml' }));
        inputs[0].files = transfer.files;
        supplied = true;
        // The current onX importer handles the file input's change event.
        inputs[0].dispatchEvent(new Event('change', { bubbles: true }));

        await wait(() => {
            const error = doc.querySelector('[data-test="error-message"]');
            if (error?.textContent.trim()) throw new Error(`onX reported: ${error.textContent.trim()}`);
            const items = [...doc.querySelectorAll('[data-test="file-item"]')];
            const imports = [...doc.querySelectorAll('[data-test="import-card-import-button"]')];
            return items.length === 1 && imports.length === 1 && !imports[0].disabled;
        }, 'the file ready to import');

        return {
            ok: true,
            supplied,
            code: 'prepared',
            message: 'Ready in onX. Review the file and click Import.',
        };
    } catch (error) {
        return fail(
            supplied ? 'handoff-unconfirmed' : 'importer-unavailable',
            supplied
                ? `${error.message} Check this onX tab before sending again.`
                : error.message,
        );
    }
}

export const onxImport = {
    ONX_ORIGIN,
    ONX_IMPORT_URL,
    ONX_PERMISSION,
    MAX_ONX_GPX_BYTES,
    prepareOnxImport,
};
