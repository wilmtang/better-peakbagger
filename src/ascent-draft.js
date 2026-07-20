// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fills a prepared Peakbagger ascent editor and submits each acknowledged
// Preview once. A failed Preview can be retried explicitly; Save stays manual.

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext) return;

    const FEET_PER_METER = 3.28084;
    const METERS_PER_MILE = 1609.344;
    const BANNER_ID = 'bpb-draft-banner';
    const BANNER_DISMISS_MS = 4000;

    const pageIds = () => {
        const params = new URLSearchParams(location.search);
        return { pid: params.get('pid'), cid: params.get('cid') };
    };

    const showBanner = (kind, message, options = {}) => {
        const { actionLabel = '', onAction = null, persistent = false } = options;
        const existing = document.getElementById(BANNER_ID);
        if (existing) existing.remove();
        const banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.className = `bpb-draft-banner bpb-draft-banner-${kind}`;
        banner.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        banner.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');

        const text = document.createElement('span');
        text.className = 'bpb-draft-banner-text';
        text.textContent = message;

        const dismissButton = document.createElement('button');
        dismissButton.type = 'button';
        dismissButton.setAttribute('aria-label', 'Dismiss notification');
        dismissButton.title = 'Dismiss';
        dismissButton.textContent = '\u00d7';
        dismissButton.className = 'bpb-draft-banner-dismiss';

        let dismissTimer = null;
        const dismiss = immediate => {
            if (dismissTimer !== null) globalThis.clearTimeout(dismissTimer);
            if (immediate) {
                banner.remove();
                return;
            }
            banner.classList.add('bpb-draft-banner-leaving');
            globalThis.setTimeout(() => banner.remove(), 160);
        };
        dismissButton.addEventListener('click', () => dismiss(true));
        banner.append(text);
        if (actionLabel && typeof onAction === 'function') {
            const actionButton = document.createElement('button');
            actionButton.type = 'button';
            actionButton.className = 'bpb-draft-banner-action';
            actionButton.textContent = actionLabel;
            actionButton.addEventListener('click', () => {
                actionButton.disabled = true;
                dismiss(true);
                void Promise.resolve().then(onAction);
            });
            banner.append(actionButton);
        }
        banner.append(dismissButton);
        (document.body || document.documentElement).prepend(banner);
        if (kind !== 'error' && !persistent) {
            banner.dataset.autoDismissMs = String(BANNER_DISMISS_MS);
            dismissTimer = globalThis.setTimeout(() => dismiss(false), BANNER_DISMISS_MS);
        }
    };

    const setField = async (id, value, digits = 0) => {
        const element = document.getElementById(id);
        if (!element || value === null || value === undefined || !Number.isFinite(Number(value))) return false;
        const numeric = Number(value);
        element.value = digits ? numeric.toFixed(digits) : String(Math.round(numeric));
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        return true;
    };

    const setTextField = (id, value) => {
        const element = document.getElementById(id);
        if (!element) return false;
        element.value = value || '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    };

    const setFieldIfEmpty = async (id, value, digits = 0) => {
        const element = document.getElementById(id);
        if (!element || String(element.value || '').trim()) return false;
        return setField(id, value, digits);
    };

    const setTextFieldIfEmpty = (id, value) => {
        const element = document.getElementById(id);
        if (!element || String(element.value || '').trim()) return false;
        return setTextField(id, value);
    };

    const setSelectValue = (id, value, dispatchChange = true) => {
        const element = document.getElementById(id);
        if (!element || element.tagName !== 'SELECT') return false;
        const stringValue = String(value);
        if (![...element.options].some(option => option.value === stringValue)) return false;
        element.value = stringValue;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        if (dispatchChange) element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    };

    const selectNewTrip = () => {
        const element = document.getElementById('TripDD');
        if (!element || element.tagName !== 'SELECT') return false;
        const option = [...element.options].find(candidate => /^\s*\*\*\s*Add New Trip\s*$/i.test(candidate.textContent || ''));
        return option ? setSelectValue('TripDD', option.value) : false;
    };

    const setDuration = async (prefix, duration) => {
        await setField(`${prefix}Day`, duration.days);
        await setField(`${prefix}Hr`, duration.hours);
        await setField(`${prefix}Min`, duration.minutes);
    };

    const fillDayStats = async dayStats => {
        if (!Array.isArray(dayStats)) return;
        for (let index = 0; index < dayStats.length; index++) {
            const row = dayStats[index];
            const sequence = index + 1;
            setTextFieldIfEmpty(`Date${sequence}`, row.date);
            await setFieldIfEmpty(`GainFt${sequence}`, row.gainM === null ? null : row.gainM * FEET_PER_METER);
            await setFieldIfEmpty(`GainM${sequence}`, row.gainM);
            await setFieldIfEmpty(`LossFt${sequence}`, row.lossM === null ? null : row.lossM * FEET_PER_METER);
            await setFieldIfEmpty(`LossM${sequence}`, row.lossM);
            await setFieldIfEmpty(`DistMi${sequence}`, row.distanceM / METERS_PER_MILE, 3);
            await setFieldIfEmpty(`DistKm${sequence}`, row.distanceM / 1000, 2);
            await setFieldIfEmpty(`MaxFt${sequence}`, row.maxElevationM === null
                ? null : row.maxElevationM * FEET_PER_METER);
            await setFieldIfEmpty(`MaxM${sequence}`, row.maxElevationM);
            await setFieldIfEmpty(`CampFt${sequence}`, row.campElevationM === null
                ? null : row.campElevationM * FEET_PER_METER);
            await setFieldIfEmpty(`CampM${sequence}`, row.campElevationM);
        }
    };

    const formIsReady = () => !!(
        document.getElementById('DateText')
        && document.getElementById('GPXUpload')
        && document.getElementById('GPXPreview')
    );

    const readPreviewResult = () => {
        const message = (document.getElementById('GPXStatusLabel')?.textContent || '')
            .replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!message) return { state: 'unknown', message: '' };
        if (/\b(?:no gps data|invalid|error|failed|failure|rejected|could not|unable|too many|only gpx)\b/i.test(message)) {
            return { state: 'error', message };
        }
        if (/\b(?:success|successful|successfully|accepted|uploaded|preview is ready)\b/i.test(message)) {
            return { state: 'success', message };
        }
        return { state: 'unknown', message };
    };

    const fillForm = async fields => {
        if (!formIsReady()) throw new Error('Peakbagger’s ascent form has changed or did not load completely.');
        // A timeless GPX derives no date; keep whatever the field already
        // holds (typically the fresh-form today autofill) instead of clearing.
        if (fields.date) setTextField('DateText', fields.date);
        setTextField('SuffixText', fields.suffix || '');

        if (fields.fillAscentDetails !== false) {
            await setField('StartFt', fields.startElevationM === null ? null : fields.startElevationM * FEET_PER_METER);
            await setField('StartM', fields.startElevationM);
            await setField('EndFt', fields.endElevationM === null ? null : fields.endElevationM * FEET_PER_METER);
            await setField('EndM', fields.endElevationM);

            await setField('UpMi', fields.upDistanceM / METERS_PER_MILE, 2);
            await setField('UpKm', fields.upDistanceM / 1000, 2);
            await setField('DnMi', fields.downDistanceM / METERS_PER_MILE, 2);
            await setField('DnKm', fields.downDistanceM / 1000, 2);
            await setDuration('Up', fields.upDuration);
            await setDuration('Dn', fields.downDuration);

            const gainFt = Number.parseFloat(document.getElementById('GainFt')?.value);
            const gainM = Number.parseFloat(document.getElementById('GainM')?.value);
            if (Number.isFinite(gainFt)) await setField('ExUpFt', Math.max(0, fields.upGainM * FEET_PER_METER - gainFt));
            if (Number.isFinite(gainM)) await setField('ExUpM', Math.max(0, fields.upGainM - gainM));
            await setField('ExDnFt', fields.downGainM * FEET_PER_METER);
            await setField('ExDnM', fields.downGainM);
            await fillDayStats(fields.dayStats);
        }

        if (fields.tripInfo) {
            selectNewTrip();
            setTextField('TripSeqText', String(fields.tripInfo.sequence));
            setTextField('TripNameText', fields.tripInfo.name);
            setTextField('TripNightsText', fields.tripInfo.nightsOut === null ? '' : String(fields.tripInfo.nightsOut));
        }

        if (fields.wildernessNightsOut !== null && fields.wildernessNightsOut !== undefined) {
            // AscentNightsDD has an inline AutoPostBack handler. Sending a
            // synthetic change here would reload before GPX Preview; its
            // selected value is still included in the Preview form post.
            setSelectValue('AscentNightsDD', fields.wildernessNightsOut, false);
        }
    };

    const validatePrivateGpx = (gpx, allowWaypoints = false) => {
        if (!gpx) return false;
        const xml = new DOMParser().parseFromString(gpx, 'application/xml');
        if (xml.getElementsByTagName('parsererror').length) return false;
        const elements = [...xml.getElementsByTagName('*')];
        const allowed = new Set(['gpx', 'wpt', 'name', 'trk', 'trkseg', 'trkpt', 'ele', 'time']);
        if (elements.some(element => !allowed.has(element.localName))) return false;
        const points = elements.filter(element => element.localName === 'trkpt');
        const waypoints = elements.filter(element => element.localName === 'wpt');
        const names = elements.filter(element => element.localName === 'name');
        const elevations = elements.filter(element => element.localName === 'ele');
        const times = elements.filter(element => element.localName === 'time');
        const segments = elements.filter(element => element.localName === 'trkseg');
        if ((!allowWaypoints && waypoints.length) || points.length + waypoints.length > 3000 || segments.length > 50) return false;
        const validCoordinate = point => {
            if (!point.hasAttribute('lat') || !point.hasAttribute('lon')) return false;
            const attributes = [...point.attributes];
            if (attributes.some(attribute => attribute.name !== 'lat' && attribute.name !== 'lon')) return false;
            const latText = point.getAttribute('lat');
            const lonText = point.getAttribute('lon');
            if (!latText.trim() || !lonText.trim()) return false;
            const lat = Number(latText);
            const lon = Number(lonText);
            return Number.isFinite(lat) && lat >= -90 && lat <= 90
                && Number.isFinite(lon) && lon >= -180 && lon <= 180;
        };
        const validLeaf = element => element.attributes.length === 0
            && element.children.length === 0
            && !!(element.textContent || '').trim();
        const validTime = element => {
            if (!validLeaf(element)) return false;
            const value = element.textContent.trim();
            const parsed = Date.parse(value);
            if (!Number.isFinite(parsed)) return false;
            const canonical = new Date(parsed).toISOString();
            return value === canonical || value === canonical.replace('.000Z', 'Z');
        };
        return points.every(point => validCoordinate(point)
                && [...point.children].every(child => child.localName === 'ele' || child.localName === 'time')
                && [...point.children].filter(child => child.localName === 'ele').length <= 1
                && [...point.children].filter(child => child.localName === 'time').length <= 1
                && [...point.childNodes].every(node => node.nodeType === 1 || !(node.textContent || '').trim()))
            && elevations.every(elevation => elevation.parentElement?.localName === 'trkpt'
                && validLeaf(elevation) && Number.isFinite(Number(elevation.textContent.trim())))
            && times.every(time => time.parentElement?.localName === 'trkpt' && validTime(time))
            && waypoints.every(waypoint => waypoint.parentElement?.localName === 'gpx'
                && validCoordinate(waypoint)
                && [...waypoint.children].every(child => child.localName === 'name')
                && [...waypoint.children].filter(child => child.localName === 'name').length <= 1
                && [...waypoint.childNodes].every(node => node.nodeType === 1 || !(node.textContent || '').trim()))
            && names.every(name => name.parentElement?.localName === 'wpt'
                && name.attributes.length === 0
                && name.children.length === 0
                && (name.textContent || '').length <= 200);
    };

    const attachGpx = (gpx, allowWaypoints) => {
        if (!validatePrivateGpx(gpx, allowWaypoints)) throw new Error('The prepared upload failed its privacy check.');
        const input = document.getElementById('GPXUpload');
        const transfer = new DataTransfer();
        transfer.items.add(new File([gpx], 'track.gpx', { type: 'application/gpx+xml' }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const applyAndPreview = async payload => {
        await fillForm(payload.fields);
        attachGpx(payload.gpx, payload.allowWaypoints);
        const acknowledgment = await ext.runtime.sendMessage({
            type: 'DRAFT_PREVIEW_STARTED',
            jobId: payload.jobId,
            pid: payload.pid,
            cid: payload.cid
        });
        if (!acknowledgment?.ok) throw new Error('Preview was already started or the draft identity changed.');
        const preview = document.getElementById('GPXPreview');
        showBanner(payload.classification,
            `${payload.classification === 'strong' ? 'Strong' : 'Probable'} match · ${payload.confidence}% confidence. Preparing GPS Preview…`);
        preview.click();
    };

    const runInitialize = async () => {
        const ids = pageIds();
        if (!ids.pid || !ids.cid) return;
        try {
            const response = await ext.runtime.sendMessage({
                type: 'DRAFT_READY',
                ...ids,
                previewResult: readPreviewResult()
            });
            if (response?.action === 'ignore') return;
            if (!response || response.action === 'error') {
                showBanner('error', response?.message || 'This ascent draft could not be prepared.');
                return;
            }
            if (response.action === 'banner') {
                if (response.dayStatsPending) {
                    await fillDayStats(response.dayStats);
                    try {
                        await ext.runtime.sendMessage({
                            type: 'DRAFT_DAY_STATS_APPLIED',
                            jobId: response.jobId,
                            pid: response.pid,
                            cid: response.cid
                        });
                    } catch (_error) {
                        // Day statistics are optional. A later page load can
                        // retry while the short-lived draft is still present.
                    }
                }
                const label = response.classification === 'strong' ? 'Strong' : 'Probable';
                showBanner(response.classification,
                    `${label} match · ${response.confidence}% confidence. Preview is ready—review Peakbagger’s result before saving.`);
                return;
            }
            if (response.action === 'wait') {
                showBanner('waiting', response.message || 'Waiting for the previous GPS Preview to finish.', {
                    persistent: true
                });
                return;
            }
            if (response.action === 'preview-error') {
                showBanner('error', response.message || 'Peakbagger did not accept GPS Preview. The draft was kept.', {
                    actionLabel: 'Retry GPS Preview',
                    onAction: () => initialize()
                });
                return;
            }
            if (response.action === 'apply') await applyAndPreview(response);
        } catch (error) {
            showBanner('error', `Draft preparation stopped: ${error.message}`);
        }
    };

    let initializationQueue = Promise.resolve();
    const initialize = () => {
        initializationQueue = initializationQueue.then(runInitialize, runInitialize);
        return initializationQueue;
    };

    ext.runtime.onMessage?.addListener(message => {
        if (message?.type === 'DRAFT_PROCEED') void initialize();
        if (message?.type === 'DRAFT_CLEARED') {
            showBanner('error', 'The cached capture was discarded. This draft is no longer connected; return to the activity to capture again.');
        }
    });

    void initialize();
})();
