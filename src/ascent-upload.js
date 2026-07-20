// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ascent-editor upload processing (isolated world, ascentedit.aspx).
//
// A fresh "Add Ascent" form gets today's date filled in, and when the user
// picks a .gpx file in Peakbagger's native GPS Track field the native Preview
// button is swapped for the extension's ✦ Process button. Processing parses
// the file on this page (the raw XML never leaves it), resolves the climb's
// timezone offline from the track's starting coordinate, and asks the
// background worker to run the same corridor-lookup/detection/derivation
// pipeline activity capture uses. Draft delivery, the privacy-cleaned upload,
// and the exactly-once GPS Preview all belong to src/ascent-draft.js; Save is
// always the user's.

import { gpxParse } from './gpx-parse.js';
import { settings as Settings } from './settings.js';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext) return;

    const pad = value => String(value).padStart(2, '0');

    const localToday = (nowDate = new Date()) =>
        `${nowDate.getFullYear()}-${pad(nowDate.getMonth() + 1)}-${pad(nowDate.getDate())}`;

    // The if-empty guard is the create/edit discriminator: an existing ascent
    // being edited arrives with its date populated and is never touched. The
    // capture draft flow sets the date unconditionally after its handshake,
    // so ordering between autofill and draft delivery cannot corrupt a draft.
    const autofillDate = () => {
        const field = document.getElementById('DateText');
        if (!field || String(field.value || '').trim()) return false;
        field.value = localToday();
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    };

    // ---- Offline timezone: track start coordinate → UTC offset -------------
    //
    // Provider metadata carries an activity's local start; a bare file does
    // not. Resolve the IANA zone from the packaged tz-lookup raster (loaded as
    // a vendor script ahead of this bundle) and read its offset at the track's
    // start instant via Intl — entirely offline, per docs/mountain-local-time.md.
    // Failures fall back to the longitude estimate, exactly as the analyzer's.

    const zoneOffsetMinutes = (timeZone, atMs) => {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
            .formatToParts(new Date(atMs));
        const name = parts.find(part => part.type === 'timeZoneName')?.value || '';
        const match = /^(?:GMT|UTC)(?:([+-])(\d{1,2}):(\d{2}))?$/.exec(name);
        if (!match) return null;
        if (!match[1]) return 0;
        const value = Number(match[2]) * 60 + Number(match[3]);
        return match[1] === '-' ? -value : value;
    };

    const resolveUtcOffsetMinutes = segments => {
        const points = (segments || []).flat();
        const start = points.find(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));
        if (!start) return null;
        const timed = points.find(point => Number.isFinite(point.time));
        const referenceMs = timed ? timed.time : Date.now();
        try {
            if (typeof globalThis.tzlookup === 'function') {
                const offset = zoneOffsetMinutes(globalThis.tzlookup(start.lat, start.lon), referenceMs);
                if (Number.isFinite(offset)) return offset;
            }
        } catch (_error) {
            // Out-of-range coordinates or a zone id unknown to this browser's
            // ICU keep the labelled solar estimate below.
        }
        return Math.round(start.lon / 15) * 60;
    };

    // ---- The ✦ Process button ---------------------------------------------

    const setupUploadProcessing = () => {
        const upload = document.getElementById('GPXUpload');
        const nativePreview = document.getElementById('GPXPreview');
        if (!upload || !nativePreview) return;

        let button = null;
        let labelElement = null;
        let status = null;
        let requestToken = 0;

        const clearStatus = () => {
            status?.remove();
            status = null;
        };

        const showStatus = (kind, message) => {
            clearStatus();
            status = document.createElement('span');
            status.className = `bpb-upload-status bpb-upload-status-${kind}`;
            status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
            status.textContent = message;
            (button || nativePreview).insertAdjacentElement('afterend', status);
        };

        const restoreNative = () => {
            requestToken++;
            button?.remove();
            button = null;
            labelElement = null;
            nativePreview.classList.remove('bpb-native-preview-hidden');
        };

        const currentGpxFile = () => {
            const file = upload.files && upload.files[0];
            return file && /\.gpx$/i.test(file.name || '') ? file : null;
        };

        const setBusy = label => {
            if (!button) return;
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            labelElement.textContent = label;
        };

        const setIdle = () => {
            if (!button) return;
            button.disabled = false;
            button.removeAttribute('aria-busy');
            labelElement.textContent = 'Process';
        };

        const showProcessButton = () => {
            clearStatus();
            if (!button) {
                button = document.createElement('button');
                button.type = 'button';
                button.className = 'bpb-process-button';
                button.setAttribute('aria-label', 'Process the chosen GPX and fill this form');
                const glyph = document.createElement('span');
                glyph.className = 'bpb-process-glyph';
                glyph.setAttribute('aria-hidden', 'true');
                glyph.textContent = '✦';
                labelElement = document.createElement('span');
                labelElement.className = 'bpb-process-label';
                button.append(glyph, labelElement);
                button.addEventListener('click', () => void processFile());
                nativePreview.parentNode.insertBefore(button, nativePreview);
            }
            nativePreview.classList.add('bpb-native-preview-hidden');
            setIdle();
        };

        const fail = message => {
            showStatus('error', message);
            restoreNative();
        };

        const handleProcessResult = async (response, token) => {
            if (!response || response.phase === 'error') {
                fail(response?.error?.message || 'The GPX could not be processed.');
                return;
            }
            if (response.phase === 'no-gps') {
                fail(response.message || 'This file contains no usable route coordinates.');
                return;
            }
            if (response.phase === 'no-matches') {
                fail('Summits were searched along the whole track, but no Peakbagger peak lies within range of it.');
                return;
            }

            const matches = response.matches || [];
            const boundPid = response.boundPid === null || response.boundPid === undefined
                ? null : String(response.boundPid);
            if (matches.length === 1 && boundPid !== null && String(matches[0].id) === boundPid) {
                setBusy('Filling form…');
                const applied = await ext.runtime.sendMessage({
                    type: 'GPX_PROCESS_APPLY',
                    jobId: response.jobId,
                    selectedIds: [matches[0].id],
                    primaryId: matches[0].id
                });
                if (token !== requestToken) return;
                if (!applied?.ok) {
                    fail(applied?.error?.message || 'The prepared draft could not be delivered.');
                    return;
                }
                // src/ascent-draft.js now fills the form, attaches the cleaned
                // GPX, and triggers GPS Preview exactly once; Peakbagger's
                // postback then reloads this page with the native buttons.
                return;
            }

            // Multi-summit, unbound-page, and bound-peak-off-track handling
            // arrive with the summit picker card (plan §3.4).
            fail(matches.length > 1
                ? `This track crosses ${matches.length} summits; choosing among them is not supported yet.`
                : 'This track’s detected summit does not match this form’s peak.');
        };

        const processFile = async () => {
            const file = currentGpxFile();
            if (!file || !button || button.disabled) return;
            const token = ++requestToken;
            clearStatus();
            setBusy('Reading track…');
            try {
                const settings = await Settings.get();
                const text = await file.text();
                const parsed = gpxParse.parseGpxData(text, {
                    retainWaypoints: settings.retainWaypoints,
                    includeTripName: settings.fillTripInfo
                });
                const utcOffsetMinutes = resolveUtcOffsetMinutes(parsed.segments);
                if (token !== requestToken) return;
                setBusy('Finding summits…');
                const response = await ext.runtime.sendMessage({
                    type: 'GPX_PROCESS_START',
                    segments: parsed.segments,
                    waypoints: parsed.waypoints,
                    trackName: parsed.trackName,
                    utcOffsetMinutes
                });
                if (token !== requestToken) return;
                await handleProcessResult(response, token);
            } catch (error) {
                if (token !== requestToken) return;
                fail(error?.code === 'no-gps-data'
                    ? 'This file has no track points. Peakbagger’s own Preview may still accept it.'
                    : (error?.message || 'The GPX file could not be read.'));
            }
        };

        upload.addEventListener('change', event => {
            // The capture draft flow attaches files programmatically; its
            // synthetic change is not trusted and must not trigger the swap.
            if (!event.isTrusted) return;
            if (currentGpxFile()) showProcessButton();
            else restoreNative();
        });
        document.getElementById('GPXRemove')?.addEventListener('click', () => restoreNative());
    };

    autofillDate();
    setupUploadProcessing();
})();
