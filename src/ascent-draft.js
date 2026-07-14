// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fills a prepared Peakbagger ascent editor and submits Preview exactly once.
// Final Save remains a deliberate user action.

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

    const showBanner = (kind, message) => {
        const existing = document.getElementById(BANNER_ID);
        if (existing) existing.remove();
        const banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        banner.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
        const colors = {
            strong: ['#067647', '#ecfdf3', '#a6f4c5'],
            probable: ['#93370d', '#fffaeb', '#fedf89'],
            error: ['#b42318', '#fef3f2', '#fecdca']
        };
        const [color, background, border] = colors[kind] || colors.probable;
        Object.assign(banner.style, {
            all: 'initial',
            position: 'fixed',
            top: '12px',
            right: '12px',
            zIndex: '2147483647',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            width: 'calc(100vw - 24px)',
            maxWidth: '460px',
            boxSizing: 'border-box',
            padding: '11px 12px 11px 14px',
            color,
            background,
            border: `1px solid ${border}`,
            borderRadius: '10px',
            font: '600 14px/1.4 system-ui, sans-serif',
            boxShadow: '0 8px 24px rgba(16,24,40,.18)',
            opacity: '1',
            transform: 'translateY(0)',
            transition: 'opacity 160ms ease, transform 160ms ease'
        });

        const text = document.createElement('span');
        Object.assign(text.style, {
            all: 'initial',
            flex: '1',
            color,
            font: '600 14px/1.4 system-ui, sans-serif'
        });
        text.textContent = message;

        const dismissButton = document.createElement('button');
        dismissButton.type = 'button';
        dismissButton.setAttribute('aria-label', 'Dismiss notification');
        dismissButton.title = 'Dismiss';
        dismissButton.textContent = '\u00d7';
        Object.assign(dismissButton.style, {
            all: 'initial',
            flex: '0 0 auto',
            width: '24px',
            height: '24px',
            color,
            font: '700 20px/22px system-ui, sans-serif',
            textAlign: 'center',
            cursor: 'pointer',
            borderRadius: '6px',
            outline: '2px solid transparent',
            outlineOffset: '1px'
        });

        let dismissTimer = null;
        const dismiss = immediate => {
            if (dismissTimer !== null) globalThis.clearTimeout(dismissTimer);
            if (immediate) {
                banner.remove();
                return;
            }
            banner.style.opacity = '0';
            banner.style.transform = 'translateY(-8px)';
            globalThis.setTimeout(() => banner.remove(), 160);
        };
        dismissButton.addEventListener('focus', () => { dismissButton.style.outlineColor = color; });
        dismissButton.addEventListener('blur', () => { dismissButton.style.outlineColor = 'transparent'; });
        dismissButton.addEventListener('click', () => dismiss(true));
        banner.append(text, dismissButton);
        (document.body || document.documentElement).prepend(banner);
        if (kind !== 'error') {
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

    const setDuration = async (prefix, duration) => {
        await setField(`${prefix}Day`, duration.days);
        await setField(`${prefix}Hr`, duration.hours);
        await setField(`${prefix}Min`, duration.minutes);
    };

    const formIsReady = () => !!(
        document.getElementById('DateText')
        && document.getElementById('GPXUpload')
        && document.getElementById('GPXPreview')
        && (document.getElementById('StartFt') || document.getElementById('StartM'))
    );

    const fillForm = async fields => {
        if (!formIsReady()) throw new Error('Peakbagger’s ascent form has changed or did not load completely.');
        setTextField('DateText', fields.date);
        setTextField('SuffixText', fields.time);

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
    };

    const validatePrivateGpx = gpx => {
        if (!gpx) return false;
        const xml = new DOMParser().parseFromString(gpx, 'application/xml');
        if (xml.getElementsByTagName('parsererror').length) return false;
        const elements = [...xml.getElementsByTagName('*')];
        const allowed = new Set(['gpx', 'trk', 'trkseg', 'trkpt']);
        if (elements.some(element => !allowed.has(element.localName))) return false;
        const points = elements.filter(element => element.localName === 'trkpt');
        const segments = elements.filter(element => element.localName === 'trkseg');
        if (points.length > 3000 || segments.length > 50) return false;
        return points.every(point => {
            const attributes = [...point.attributes];
            if (attributes.some(attribute => attribute.name !== 'lat' && attribute.name !== 'lon')) return false;
            const lat = Number(point.getAttribute('lat'));
            const lon = Number(point.getAttribute('lon'));
            return Number.isFinite(lat) && lat >= -90 && lat <= 90
                && Number.isFinite(lon) && lon >= -180 && lon <= 180;
        });
    };

    const attachGpx = gpx => {
        if (!validatePrivateGpx(gpx)) throw new Error('The prepared upload failed its privacy check.');
        const input = document.getElementById('GPXUpload');
        const transfer = new DataTransfer();
        transfer.items.add(new File([gpx], 'track.gpx', { type: 'application/gpx+xml' }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const applyAndPreview = async payload => {
        await fillForm(payload.fields);
        attachGpx(payload.gpx);
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

    const initialize = async () => {
        const ids = pageIds();
        if (!ids.pid || !ids.cid) return;
        try {
            const response = await ext.runtime.sendMessage({ type: 'DRAFT_READY', ...ids });
            if (response?.action === 'ignore') return;
            if (!response || response.action === 'error') {
                showBanner('error', response?.message || 'This ascent draft could not be prepared.');
                return;
            }
            if (response.action === 'banner') {
                const label = response.classification === 'strong' ? 'Strong' : 'Probable';
                showBanner(response.classification,
                    `${label} match · ${response.confidence}% confidence. Preview is ready—review Peakbagger’s result before saving.`);
                return;
            }
            if (response.action === 'apply') await applyAndPreview(response);
        } catch (error) {
            showBanner('error', `Draft preparation stopped: ${error.message}`);
        }
    };

    void initialize();
})();
