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

import { matchLabel, matchTone } from '../capture/match-confidence.js';
import {
    MAX_GPX_BYTES,
    MAX_GPX_TEXT_CHARS,
    gpxLimitMessage,
} from '../capture/capture-resource-limits.js';
import { gpxParse } from '../gpx/gpx-parse.js';
import { gpxMetrics as Metrics } from '../gpx/gpx-metrics.js';
import { boundedText as BoundedText } from '../net/bounded-text.js';
import { settings as Settings } from '../settings/settings.js';
import { units as Units } from '../ui/units.js';
import tzlookup from 'tz-lookup';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext) return;

    const pad = value => String(value).padStart(2, '0');

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
    // not. Resolve the IANA zone from the tz-lookup raster bundled into this
    // content script and read its offset at the track's start instant via Intl
    // — entirely offline, per docs/mountain-local-time.md.
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
        const start = points.find(point => Metrics.isValidCoordinate(point.lat, point.lon));
        if (!start) return null;
        const timed = points.find(point => Metrics.isValidCoordinate(point.lat, point.lon)
            && Metrics.isValidTimestamp(point.time));
        const referenceMs = timed ? timed.time : Date.now();
        try {
            const offset = zoneOffsetMinutes(tzlookup(start.lat, start.lon), referenceMs);
            if (Metrics.isValidUtcOffsetMinutes(offset)) return offset;
        } catch (_error) {
            // A zone id unknown to this browser's ICU keeps the labelled solar
            // estimate below.
        }
        return Metrics.longitudeUtcOffsetMinutes(start.lon);
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

    // detectPageUnits stays here — it reads this page's own field order — and
    // is handed to the shared resolver rather than reimplementing the
    // preference logic beside it.
    const resolveDisplayUnits = settings => Units.resolveUnits(settings, detectPageUnits);
    const formatTrackDistance = Units.formatDistance;
    const formatApproachDistance = Units.formatApproach;

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
        let selectionGeneration = 0;
        let selectedFile = null;
        const pageSessionId = (() => {
            try { return globalThis.crypto.randomUUID(); }
            catch (error) { return `page-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
        })();

        const fileIdentity = file => ({
            name: String(file?.name || '(no file)').slice(0, 255),
            size: Number.isSafeInteger(file?.size) && file.size >= 0 ? file.size : 0,
            lastModified: Number.isFinite(file?.lastModified) && file.lastModified >= 0
                ? file.lastModified : 0,
            type: String(file?.type || '').slice(0, 100),
        });
        const sameFileIdentity = (left, right) => !!left && !!right
            && left.name === right.name && left.size === right.size
            && left.lastModified === right.lastModified && left.type === right.type;
        const selectionMessage = (generation, identity) => ({
            pageSessionId,
            selectionGeneration: generation,
            fileIdentity: identity,
        });

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

        const resetNativeUi = () => {
            removeCard();
            button?.remove();
            button = null;
            labelElement = null;
            nativePreview.classList.remove('bpb-native-preview-hidden');
        };

        const restoreNative = () => {
            requestToken++;
            const generation = ++selectionGeneration;
            selectedFile = null;
            resetNativeUi();
            void ext.runtime.sendMessage({
                type: 'GPX_PROCESS_INVALIDATE',
                ...selectionMessage(generation, fileIdentity(null)),
            }).catch(() => {});
        };

        const nativeGpxFile = () => {
            const file = upload.files && upload.files[0];
            return file && /\.gpx$/i.test(file.name || '') ? file : null;
        };
        const currentGpxFile = () => {
            const file = nativeGpxFile();
            if (!file || !selectedFile || file !== selectedFile.file
                || !sameFileIdentity(fileIdentity(file), selectedFile.identity)) return null;
            return file;
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
            if (token !== requestToken || !selectedFile
                || response.pageSessionId !== pageSessionId
                || response.selectionGeneration !== selectedFile.generation
                || !sameFileIdentity(response.fileIdentity, selectedFile.identity)) return;
            setBusy(primaryId !== null ? 'Filling form…' : 'Opening drafts…');
            let applied;
            try {
                applied = await ext.runtime.sendMessage({
                    type: 'GPX_PROCESS_APPLY',
                    jobId: response.jobId,
                    selectedIds,
                    primaryId,
                    ...selectionMessage(selectedFile.generation, selectedFile.identity),
                });
            } catch (error) {
                if (token !== requestToken) return;
                console.error('Better Peakbagger: prepared draft delivery failed', error);
                fail('The prepared draft could not be delivered. Reload the ascent form and try again.');
                return;
            }
            if (token !== requestToken) return;
            if (!applied?.ok) {
                removeCard();
                fail(applied?.error?.message || 'The prepared draft could not be delivered.');
                return;
            }
            removeCard();
            if (primaryId === null) {
                // Only sibling drafts were opened; this page keeps its native
                // upload path.
                const count = (applied.tabIds || []).length;
                const tabs = `${count} draft tab${count === 1 ? '' : 's'}`;
                showStatus('info', applied.groupWarning
                    ? `Opened ${tabs}. Your browser didn’t group them.`
                    : `Opened ${tabs} in the Peak Drafts group.`);
            } else if (applied.groupWarning) {
                showStatus('info', 'Drafts opened. Your browser didn’t group the tabs.');
            }
            if (primaryId === null) restoreNative();
            // With a primary, src/ascent/ascent-draft.js now fills this page (bound)
            // or the standard draft delivery fills it after navigation
            // (unbound); Peakbagger's postback then restores the native
            // buttons. The button deliberately stays busy until then.
        };

        // ---- Summit picker card (plan §3.4, Option C) ----------------------

        const summitChip = match => {
            const chip = document.createElement('span');
            chip.className = `bpb-summit-chip bpb-summit-chip-${matchTone(match.classification)}`;
            chip.textContent = matchLabel(match.classification);
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
            const selection = selectedFile;
            const token = ++requestToken;
            clearStatus();
            setBusy('Reading track…');
            let settings;
            try {
                settings = await Settings.requireCurrent();
            } catch (error) {
                if (token !== requestToken) return;
                console.error('Better Peakbagger: capture settings read failed', error);
                fail('Capture settings could not be read. Reload and try again. Nothing was captured.');
                return;
            }
            try {
                const displayUnits = resolveDisplayUnits(settings);
                const text = await BoundedText.readBoundedBlobText(file, {
                    maxBytes: MAX_GPX_BYTES,
                    maxChars: MAX_GPX_TEXT_CHARS,
                    label: 'GPX file',
                });
                const parsed = gpxParse.parseGpxData(text, {
                    retainWaypoints: settings.retainWaypoints,
                    includeTripName: settings.fillTripInfo
                });
                const utcOffsetMinutes = resolveUtcOffsetMinutes(parsed.segments);
                if (token !== requestToken || selectedFile !== selection || currentGpxFile() !== file) return;
                setBusy('Finding summits…');
                const response = await ext.runtime.sendMessage({
                    type: 'GPX_PROCESS_START',
                    segments: parsed.segments,
                    waypoints: parsed.waypoints,
                    trackName: parsed.trackName,
                    utcOffsetMinutes,
                    ...selectionMessage(selection.generation, selection.identity),
                });
                if (token !== requestToken || selectedFile !== selection || currentGpxFile() !== file) return;
                if (response?.pageSessionId !== pageSessionId
                    || response?.selectionGeneration !== selection.generation
                    || !sameFileIdentity(response?.fileIdentity, selection.identity)) return;
                await handleProcessResult(response, token, displayUnits);
            } catch (error) {
                if (token !== requestToken) return;
                if (error?.code === 'no-gps-data') {
                    fail('This file has no track points. Peakbagger’s own Preview may still accept it.');
                    return;
                }
                if (error?.code === 'invalid-gpx') {
                    fail('The GPX file contains invalid XML.');
                    return;
                }
                if (error?.code === 'gpx-too-large' || BoundedText.isLimitError(error)) {
                    fail(gpxLimitMessage());
                    return;
                }
                console.error('Better Peakbagger: local GPX read failed', error);
                fail('The GPX file could not be read. Reload the ascent form and try again.');
            }
        };

        const handleFileChange = async file => {
            const token = ++requestToken;
            const generation = ++selectionGeneration;
            const identity = fileIdentity(file);
            selectedFile = null;
            clearStatus();
            resetNativeUi();
            let invalidated;
            try {
                invalidated = await ext.runtime.sendMessage({
                    type: 'GPX_PROCESS_INVALIDATE',
                    ...selectionMessage(generation, identity),
                });
            } catch (error) {
                if (token !== requestToken) return;
                if (file && /\.gpx$/i.test(file.name || '')) {
                    showStatus('error', 'The selected GPX could not be prepared. Reload the ascent form and try again.');
                }
                return;
            }
            if (token !== requestToken || generation !== selectionGeneration) return;
            if (!invalidated?.ok) {
                if (file && /\.gpx$/i.test(file.name || '')) {
                    showStatus('error', 'The selected GPX could not be prepared. Reload the ascent form and try again.');
                }
                return;
            }
            if (!file || !/\.gpx$/i.test(file.name || '')) return;
            selectedFile = { file, identity, generation };
            showProcessButton();
        };

        upload.addEventListener('change', event => {
            // The capture draft flow attaches files programmatically; its
            // synthetic change is not trusted and must not trigger the swap.
            if (!event.isTrusted) return;
            void handleFileChange(upload.files && upload.files[0]);
        });
        document.getElementById('GPXRemove')?.addEventListener('click', () => restoreNative());
        window.addEventListener('pagehide', restoreNative, { once: true });
    };

    autofillDate();
    setupUploadProcessing();
})();
