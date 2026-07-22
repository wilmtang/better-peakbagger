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
// and the exactly-once GPS Preview all belong to src/ascent/ascent-draft.js; Save is
// always the user's.

import { gpxParse } from '../gpx/gpx-parse.js';
import { settings as Settings } from '../settings/settings.js';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext) return;

    const pad = value => String(value).padStart(2, '0');
    const METERS_PER_MILE = 1609.344;
    const FEET_PER_METER = 3.28084;

    const localToday = (nowDate = new Date()) =>
        `${nowDate.getFullYear()}-${pad(nowDate.getMonth() + 1)}-${pad(nowDate.getDate())}`;

    // The if-empty guard is the create/edit discriminator: an existing ascent
    // being edited arrives with its date populated and is never touched. Mark
    // only our generated value so local GPX processing may replace it with the
    // track's date without mistaking a date the user entered for a default.
    const autofillDate = () => {
        const field = document.getElementById('DateText');
        if (!field || String(field.value || '').trim()) return false;
        const clearGeneratedMarker = event => {
            if (event.isTrusted) delete field.dataset.bpbAutofilled;
        };
        field.addEventListener('input', clearGeneratedMarker);
        field.addEventListener('change', clearGeneratedMarker);
        field.value = localToday();
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        field.dataset.bpbAutofilled = 'date';
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

    // Peakbagger renders both values on the editor, but orders each unit pair
    // according to the page preference. Auto follows that native order; an
    // explicit extension choice remains authoritative.
    const detectPageUnits = () => {
        for (const [imperialId, metricId] of [['UpMi', 'UpKm'], ['StartFt', 'StartM']]) {
            const fields = [...document.querySelectorAll(`#${imperialId}, #${metricId}`)];
            if (fields.length === 2) return fields[0].id === metricId ? 'metric' : 'imperial';
        }
        return 'imperial';
    };

    const resolveDisplayUnits = settings => settings.units === 'metric' || settings.units === 'imperial'
        ? settings.units
        : detectPageUnits();

    const formatTrackDistance = (meters, units) => units === 'metric'
        ? `${(meters / 1000).toFixed(1)} km`
        : `${(meters / METERS_PER_MILE).toFixed(1)} mi`;

    const formatApproachDistance = (meters, units) => units === 'metric'
        ? `${Math.round(meters)} m`
        : `${Math.round(meters * FEET_PER_METER)} ft`;

    // ---- The ✦ Process button ---------------------------------------------

    const setupUploadProcessing = () => {
        const upload = document.getElementById('GPXUpload');
        const nativePreview = document.getElementById('GPXPreview');
        if (!upload || !nativePreview) return;

        const uploadCell = upload.closest('td');
        if (uploadCell && !document.getElementById('bpb-capture-hint')) {
            const hint = document.createElement('p');
            hint.id = 'bpb-capture-hint';
            hint.className = 'bpb-capture-hint';
            hint.textContent = 'Garmin or Strava activity? Open it there, then click Better Peakbagger in the browser toolbar to capture it directly.';
            uploadCell.append(hint);
        }

        let button = null;
        let labelElement = null;
        let status = null;
        let card = null;
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

        const removeCard = () => {
            card?.remove();
            card = null;
        };

        const restoreNative = () => {
            requestToken++;
            removeCard();
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
            removeCard();
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

        const applySelection = async (response, selectedIds, primaryId, token) => {
            setBusy(primaryId !== null ? 'Filling form…' : 'Opening drafts…');
            let applied;
            try {
                applied = await ext.runtime.sendMessage({
                    type: 'GPX_PROCESS_APPLY',
                    jobId: response.jobId,
                    selectedIds,
                    primaryId
                });
            } catch (error) {
                if (token !== requestToken) return;
                fail(error?.message || 'The prepared draft could not be delivered.');
                return;
            }
            if (token !== requestToken) return;
            if (!applied?.ok) {
                removeCard();
                fail(applied?.error?.message || 'The prepared draft could not be delivered.');
                return;
            }
            removeCard();
            if (applied.groupWarning) showStatus('info', applied.groupWarning);
            if (primaryId === null) {
                // Only sibling drafts were opened; this page keeps its native
                // upload path.
                const count = (applied.tabIds || []).length;
                showStatus('info', `Opened ${count} draft tab${count === 1 ? '' : 's'} in the Peak Drafts group.`);
                restoreNative();
            }
            // With a primary, src/ascent/ascent-draft.js now fills this page (bound)
            // or the standard draft delivery fills it after navigation
            // (unbound); Peakbagger's postback then restores the native
            // buttons. The button deliberately stays busy until then.
        };

        // ---- Summit picker card (plan §3.4, Option C) ----------------------

        const summitChip = match => {
            const chip = document.createElement('span');
            const kind = match.classification === 'strong' ? 'strong'
                : match.classification === 'probable' ? 'probable' : 'off';
            chip.className = `bpb-summit-chip bpb-summit-chip-${kind}`;
            chip.textContent = kind === 'strong' ? 'Strong' : kind === 'probable' ? 'Probable' : 'Off track';
            return chip;
        };

        // The card title already says "along this track"; keep each row's
        // encounter short enough to never truncate.
        const encounterMeta = (match, units) => {
            const parts = [];
            if (match.time) parts.push(`at ${match.time}`);
            if (Number.isFinite(match.upDistanceM)) parts.push(formatTrackDistance(match.upDistanceM, units));
            return parts.join(' · ');
        };

        const showSummitCard = (response, token, units) => {
            removeCard();
            clearStatus();
            setIdle();
            const matches = response.matches || [];
            const fallback = response.boundFallback || null;
            const boundPid = response.boundPid === null || response.boundPid === undefined
                ? null : String(response.boundPid);
            const confidenceById = new Map();

            card = document.createElement('section');
            card.className = 'bpb-summit-card';
            card.setAttribute('aria-label', 'Summits detected along this track');

            const heading = document.createElement('h3');
            heading.className = 'bpb-summit-card-title';
            heading.textContent = matches.length === 0
                ? 'No summits detected within range of this track'
                : matches.length === 1
                    ? 'One summit detected along this track'
                    : `${matches.length} summits detected along this track`;
            card.append(heading);

            const list = document.createElement('ul');
            list.className = 'bpb-summit-list';
            const checkboxes = new Map();

            const summitRow = (match, { fallbackRow = false } = {}) => {
                confidenceById.set(String(match.id), match.confidence);
                const item = document.createElement('li');
                const label = document.createElement('label');
                label.className = 'bpb-summit-row';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'bpb-summit-check';
                checkbox.checked = !fallbackRow && (match.selected === true || String(match.id) === boundPid);
                checkboxes.set(String(match.id), checkbox);
                const name = document.createElement('span');
                name.className = 'bpb-summit-name';
                name.textContent = match.name;
                const confidence = document.createElement('span');
                confidence.className = 'bpb-summit-confidence';
                confidence.textContent = `${match.confidence}%`;
                const meta = document.createElement('span');
                meta.className = 'bpb-summit-meta';
                meta.textContent = fallbackRow
                    ? `${formatApproachDistance(match.closestApproachM, units)} from the summit`
                    : encounterMeta(match, units);
                label.append(checkbox, name, summitChip(match), confidence, meta);
                item.append(label);
                return item;
            };

            matches.forEach(match => list.append(summitRow(match)));

            if (fallback) {
                const note = document.createElement('p');
                note.className = 'bpb-summit-note';
                note.textContent = `Your track’s closest approach to ${fallback.name} is ${formatApproachDistance(fallback.closestApproachM, units)} from the summit. Check it to use ${fallback.name} anyway.`;
                card.append(note);
                list.append(summitRow(fallback, { fallbackRow: true }));
            } else if (boundPid !== null && !matches.some(match => String(match.id) === boundPid)) {
                const note = document.createElement('p');
                note.className = 'bpb-summit-note';
                note.textContent = 'Your track never comes within range of this page’s peak; the summits above can open as drafts instead.';
                card.append(note);
            }
            card.append(list);

            const actions = document.createElement('div');
            actions.className = 'bpb-summit-actions';
            const applyButton = document.createElement('button');
            applyButton.type = 'button';
            applyButton.className = 'bpb-summit-apply';
            const cancelButton = document.createElement('button');
            cancelButton.type = 'button';
            cancelButton.className = 'bpb-summit-cancel';
            cancelButton.textContent = 'Cancel';
            actions.append(applyButton, cancelButton);
            card.append(actions);

            const selection = () => {
                const selectedIds = [...checkboxes].filter(([, checkbox]) => checkbox.checked).map(([id]) => id);
                let primaryId = null;
                if (boundPid !== null) {
                    primaryId = selectedIds.includes(boundPid) ? boundPid : null;
                } else if (selectedIds.length) {
                    primaryId = selectedIds.reduce((best, id) =>
                        confidenceById.get(id) > confidenceById.get(best) ? id : best);
                }
                return { selectedIds, primaryId };
            };

            const updateAction = () => {
                const { selectedIds, primaryId } = selection();
                const siblingCount = selectedIds.length - (primaryId === null ? 0 : 1);
                applyButton.disabled = !selectedIds.length;
                applyButton.textContent = primaryId === null
                    ? (siblingCount ? `Open ${siblingCount} draft${siblingCount === 1 ? '' : 's'}` : 'Fill this ascent')
                    : siblingCount
                        ? `Fill + open ${siblingCount} draft${siblingCount === 1 ? '' : 's'}`
                        : 'Fill this ascent';
            };
            for (const checkbox of checkboxes.values()) checkbox.addEventListener('change', updateAction);
            updateAction();

            applyButton.addEventListener('click', () => {
                const { selectedIds, primaryId } = selection();
                if (!selectedIds.length) return;
                applyButton.disabled = true;
                cancelButton.disabled = true;
                void applySelection(response, selectedIds.map(Number),
                    primaryId === null ? null : Number(primaryId), token);
            });
            cancelButton.addEventListener('click', () => {
                restoreNative();
            });

            (button || nativePreview).insertAdjacentElement('afterend', card);
        };

        const handleProcessResult = async (response, token, units) => {
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
            // Option C: exactly one detected summit that is (or, on an unbound
            // page, becomes) this page's peak fills immediately, no card;
            // ambiguity is the only thing that earns UI.
            if (matches.length === 1 && !response.boundFallback
                && (boundPid === null || String(matches[0].id) === boundPid)) {
                await applySelection(response, [matches[0].id], matches[0].id, token);
                return;
            }
            showSummitCard(response, token, units);
        };

        const processFile = async () => {
            const file = currentGpxFile();
            if (!file || !button || button.disabled) return;
            const token = ++requestToken;
            clearStatus();
            setBusy('Reading track…');
            try {
                const settings = await Settings.get();
                const displayUnits = resolveDisplayUnits(settings);
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
                await handleProcessResult(response, token, displayUnits);
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
