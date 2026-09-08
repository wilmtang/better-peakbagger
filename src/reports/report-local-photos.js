// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { reportPhoto as Pending } from '../photos/report-photo.js';
import { photoProject as Project } from '../photos/photo-project.js';
import { trustedAction as Trusted } from '../ui/trusted-action.js';

export function installReportLocalPhotos({ ext, form, textarea, ui, getEditor, flush, saveDraft, launchEditor, replaceText }) {
    const status = document.createElement('div');
    status.className = 'bpb-re-local-photo-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    ui.append(status);
    const say = message => { status.textContent = message; status.hidden = !message; };
    const send = async message => {
        const result = await ext.runtime.sendMessage(message);
        if (!result?.ok) throw new Error(result?.error?.message || 'The photo could not be saved. Your report is still open.');
        return result;
    };
    const previews = new Map();
    let preparing = 0;
    let saving = false;
    let pasteFailures = 0;
    let sequence = 0;
    let pageGeneration = 0;
    window.addEventListener('pagehide', () => { pageGeneration++; });
    let pasteQueue = Promise.resolve();
    const generation = () => `report-photo-${Date.now()}-${++sequence}`;
    const replaceNode = (from, to, alt) => {
        const editor = getEditor();
        if (!editor || editor.isDestroyed) return false;
        let transaction = editor.state.tr;
        editor.state.doc.descendants((node, pos) => {
            if (node.type.name === 'image' && node.attrs.src === from) {
                transaction = to ? transaction.setNodeMarkup(pos, null, { ...node.attrs, src: to, alt: alt ?? node.attrs.alt })
                    : transaction.delete(transaction.mapping.map(pos), transaction.mapping.map(pos + node.nodeSize));
            }
        });
        if (!transaction.docChanged) return false;
        editor.view.dispatch(transaction);
        return true;
    };
    const resolvePreview = async src => {
        const localPhotoId = Pending.id(src);
        if (!localPhotoId) return src;
        if (!previews.has(src)) previews.set(src, send({ type: 'PHOTO_REPORT_READ', localPhotoId })
            .then(result => result.dataUrl).catch(error => { previews.delete(src); throw error; }));
        return previews.get(src);
    };
    const canvasBlob = (canvas, mime) => new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The image could not be prepared.')), mime);
    });
    const prepare = async file => {
        if (!file.size || file.size > Pending.MAX_BYTES) throw new Error('Paste an image smaller than 16 MiB.');
        const bitmap = await createImageBitmap(file);
        try {
            if (!Project.cleanImageDimensions(bitmap)) throw new Error('The photo dimensions are unsupported.');
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.getContext('2d').drawImage(bitmap, 0, 0);
            const blob = await canvasBlob(canvas, 'image/png');
            if (blob.size > Pending.MAX_BYTES) throw new Error('This image is too large to paste. Use a smaller copy.');
            const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            return { dataUrl: await Pending.toDataUrl(blob), thumbnail: canvas.toDataURL('image/png'),
                width: bitmap.width, height: bitmap.height };
        } finally { bitmap.close(); }
    };
    const paste = event => {
        const editor = getEditor();
        if (!event.isTrusted || saving || !editor || !editor.view.dom.contains(event.target)) return;
        const files = [...(event.clipboardData?.items || [])]
            .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
            .map(item => item.getAsFile()).filter(Boolean);
        if (!files.length) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        for (const file of files) {
            const provisional = Pending.url(crypto.randomUUID());
            if (!file.size || file.size > Pending.MAX_BYTES) { say('Paste an image smaller than 16 MiB.'); continue; }
            previews.set(provisional, Pending.toDataUrl(file));
            editor.chain().insertContent({ type: 'image', attrs: { src: provisional, alt: 'Pasted photo', width: 640 } }).run();
            preparing++;
            say('Saving photo on this device…');
            pasteQueue = pasteQueue.then(async () => {
                try {
                    await send({ type: 'PHOTO_REPORT_STATUS' }).then(result => {
                        if (!result.configured || !result.permissionGranted) throw new Error('Set up ImgBB in Settings before pasting photos.');
                    });
                    const prepared = await prepare(file);
                    const actionGeneration = generation();
                    const activation = await Trusted.issue(ext, event, 'report-photos', actionGeneration);
                    if (!activation) throw new Error('Paste the photo again to add it.');
                    const result = await send({ type: 'PHOTO_REPORT_CREATE', ...prepared, localPhotoId: Pending.id(provisional),
                        generation: actionGeneration, activationToken: activation.token });
                    previews.set(result.url, Promise.resolve(prepared.dataUrl));
                    replaceNode(provisional, result.url, '');
                    flush();
                    await saveDraft();
                    say('Photos stay on this device until you save the TR.');
                } catch (error) {
                    pasteFailures++;
                    previews.delete(provisional);
                    replaceNode(provisional, null);
                    say(error.message);
                } finally {
                    preparing--;
                }
            });
        }
    };
    document.addEventListener('paste', paste, true);
    const pendingIds = () => { flush(); return Pending.ids(textarea.value); };
    const gate = event => {
        const control = event.type === 'click' ? event.target.closest?.('#SaveButton, #SaveButton2') : event.submitter;
        const save = event.type === 'submit' ? event.target === form && (!control || ['SaveButton', 'SaveButton2'].includes(control.id))
            : control?.form === form;
        if (!save || event.defaultPrevented || (!preparing && !saving && !pendingIds().length)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (saving) return;
        if (!event.isTrusted) { say('Use Save Ascent to upload the pending photos.'); return; }
        if (typeof form.reportValidity === 'function' && !form.reportValidity()) return;
        const savePageGeneration = pageGeneration;
        const failuresBeforeSave = pasteFailures;
        saving = true;
        const wasInert = form.inert;
        form.inert = true;
        const actionGeneration = generation();
        const grantPromise = Trusted.begin(ext, event, 'report-photos', actionGeneration);
        void (async () => {
            let workflow;
            let ready = false;
            try {
                workflow = await grantPromise;
                if (!workflow) throw new Error('Use Save Ascent again to upload the photos.');
                await pasteQueue;
                if (pasteFailures !== failuresBeforeSave) throw new Error('A pasted photo could not be prepared. Paste it again before saving.');
                if (pageGeneration !== savePageGeneration) throw new Error('You left this report during preparation. Review it and save again.');
                const ids = pendingIds();
                const original = textarea.value;
                const replacements = new Map();
                for (let index = 0; index < ids.length; index++) {
                    say(`Uploading photo ${index + 1} of ${ids.length}…`);
                    const result = await send({ type: 'PHOTO_REPORT_UPLOAD', localPhotoId: ids[index],
                        generation: actionGeneration, grantToken: workflow.grantToken });
                    if (pageGeneration !== savePageGeneration) throw new Error('You left this report during upload. Review it and save again.');
                    if (!/^https:\/\//.test(result.url) || Pending.id(result.url)) throw new Error('The upload did not return a hosted image.');
                    replacements.set(Pending.url(ids[index]), result.url);
                }
                flush();
                if (textarea.value !== original) throw new Error('The report changed during upload. Review it and save again.');
                replaceText(replacements);
                flush();
                if (Pending.ids(textarea.value).length) throw new Error('Some photos are still local. Review the report and save again.');
                await saveDraft();
                say('Photos uploaded. Saving report…');
                ready = true;
            } catch (error) {
                say(`${error.message} The report has not been submitted.`);
            } finally {
                await Trusted.end(ext, workflow, actionGeneration);
                saving = false;
                form.inert = wasInert;
            }
            if (ready && form.isConnected && pageGeneration === savePageGeneration) {
                // Resume the user's original submission through native validation;
                // never click a Save control or call the validation-bypassing submit().
                form.requestSubmit(control || form.querySelector('#SaveButton, #SaveButton2') || undefined);
            }
        })();
    };
    document.addEventListener('click', gate, true);
    document.addEventListener('submit', gate, true);
    window.addEventListener('beforeunload', event => {
        if (preparing || saving) { event.preventDefault(); event.returnValue = ''; }
    });
    return {
        showError: say,
        busy: () => preparing > 0 || saving,
        resolvePreview,
        edit: (event, src) => { const id = Pending.id(src); if (id && !saving && !preparing) void launchEditor(event, id); },
        receive: (message, sender) => {
            if (message.type !== 'PHOTO_LOCAL_RESULT' || sender?.id !== ext.runtime.id) return false;
            const from = Pending.url(message.replacesLocalPhotoId);
            if (!from || !Pending.id(message.url)) return false;
            const replaced = replaceNode(from, message.url, message.alt);
            if (replaced) { flush(); void saveDraft(); say('Photo updated locally. It will upload when you save the TR.'); }
            return replaced;
        },
    };
}
