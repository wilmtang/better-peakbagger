// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — shared page-world lifecycle for the 3D terrain surfaces.
// Surface modules still own subject discovery, consent state, native-map DOM,
// and init payloads. This module owns the state machine and camera handoff so
// BigMap, Peak pages, and the GPX Analyzer cannot drift independently.

import { terrainCamera as TerrainCamera } from './terrain-camera.js';

const DEFAULT_LOAD_TIMEOUT_MS = 17000;
const DEFAULT_CAMERA_TIMEOUT_MS = 1000;

const create = ({
    toggle,
    compass = null,
    isEnabled,
    idleUi,
    buildInit,
    nativeMap,
    hideNativeMap,
    restoreNativeMap,
    post,
    requestConsent,
    clearFailure,
    showFailure,
    setFailureTheme = () => {},
    theme,
    position,
    loadTimeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
    cameraTimeoutMs = DEFAULT_CAMERA_TIMEOUT_MS
}) => {
    let state = 'idle';
    let loadTimer = null;
    let navTop = null;
    let viewCamera = null;
    let stopPending = false;
    let cameraRequestId = 0;

    const snapshot = () => ({ state, navTop, stopPending });

    const clearLoadTimer = () => {
        if (loadTimer === null) return;
        clearTimeout(loadTimer);
        loadTimer = null;
    };

    const update = () => {
        const effectiveTheme = theme();
        toggle.dataset.theme = effectiveTheme;
        setFailureTheme(effectiveTheme);
        if (compass) {
            compass.element.dataset.theme = effectiveTheme;
            compass.setVisible(state === 'active' && !stopPending);
        }

        toggle.classList.remove('bpb-map-3d-toggle-loading');
        toggle.removeAttribute('aria-busy');
        if (stopPending) {
            toggle.disabled = true;
            toggle.textContent = '2D';
            toggle.title = 'Returning to the 2D map…';
            toggle.setAttribute('aria-label', 'Returning to the 2D map');
            toggle.setAttribute('aria-pressed', 'true');
        } else if (state === 'loading') {
            toggle.disabled = false;
            toggle.textContent = '3D';
            toggle.classList.add('bpb-map-3d-toggle-loading');
            toggle.setAttribute('aria-busy', 'true');
            toggle.title = 'Cancel loading 3D terrain';
            toggle.setAttribute('aria-label', 'Cancel loading 3D terrain');
            toggle.setAttribute('aria-pressed', 'false');
        } else if (state === 'active') {
            toggle.disabled = false;
            toggle.textContent = '2D';
            toggle.title = 'Return to the 2D map';
            toggle.setAttribute('aria-label', 'Return to the 2D map');
            toggle.setAttribute('aria-pressed', 'true');
        } else {
            const idle = idleUi();
            toggle.disabled = idle.disabled === true;
            toggle.textContent = '3D';
            toggle.title = idle.title;
            toggle.setAttribute('aria-label', idle.ariaLabel);
            toggle.setAttribute('aria-pressed', 'false');
        }
        position(snapshot());
    };

    const fail = reason => {
        clearLoadTimer();
        state = 'idle';
        navTop = null;
        viewCamera = null;
        stopPending = false;
        restoreNativeMap();
        post('destroy');
        update();
        showFailure(reason);
    };

    const start = (consentGranted = false) => {
        if ((!consentGranted && !isEnabled()) || state !== 'idle') return false;
        const detail = buildInit();
        if (!detail) return false;

        state = 'loading';
        clearFailure();
        viewCamera = TerrainCamera.fromLeaflet(nativeMap());
        update();
        post('init', {
            ...detail,
            ...(viewCamera ? { camera: viewCamera } : {})
        });
        loadTimer = setTimeout(() => {
            if (state === 'loading') fail('timeout');
        }, loadTimeoutMs);
        return true;
    };

    const finishStop = () => {
        clearLoadTimer();
        if (state === 'active' && viewCamera) {
            TerrainCamera.applyToLeaflet(nativeMap(), viewCamera);
        }
        state = 'idle';
        navTop = null;
        viewCamera = null;
        stopPending = false;
        restoreNativeMap();
        post('destroy');
        clearFailure();
        update();
    };

    const stop = () => {
        if (state !== 'active') {
            finishStop();
            return;
        }
        if (stopPending) return;
        clearLoadTimer();
        stopPending = true;
        update();
        cameraRequestId++;
        post('cameraRequest', { requestId: cameraRequestId });
        loadTimer = setTimeout(finishStop, cameraTimeoutMs);
    };

    const handleMessage = data => {
        if (data.type === 'loaded' && state === 'loading') {
            clearLoadTimer();
            const camera = TerrainCamera.clean(data.camera);
            if (camera) viewCamera = camera;
            state = 'active';
            navTop = Number.isFinite(data.navTop) ? data.navTop : null;
            hideNativeMap();
            clearFailure();
            update();
            return true;
        }
        if (data.type === 'metrics' && state === 'active') {
            if (Number.isFinite(data.navTop)) navTop = data.navTop;
            position(snapshot());
            return true;
        }
        if (data.type === 'view' && state === 'active') {
            if (compass && Number.isFinite(data.bearing) && Number.isFinite(data.pitch)) {
                const bearing = ((data.bearing % 360) + 360) % 360;
                const pitch = Math.min(85, Math.max(0, data.pitch));
                compass.update(bearing, pitch);
            }
            return true;
        }
        if (data.type === 'camera' && state === 'active') {
            const camera = TerrainCamera.clean(data.camera);
            if (camera) viewCamera = camera;
            if (stopPending && data.requestId === cameraRequestId) finishStop();
            return true;
        }
        if (data.type === 'error' && (state === 'loading' || state === 'active')) {
            fail(data.reason);
            return true;
        }
        return false;
    };

    toggle.addEventListener('click', () => {
        if (state === 'active' || state === 'loading') {
            stop();
            return;
        }
        if (state !== 'idle') return;
        if (!isEnabled()) {
            requestConsent();
            return;
        }
        start();
    });

    return {
        handleMessage,
        isActive: () => state === 'active',
        isIdle: () => state === 'idle',
        isOpen: () => state === 'loading' || state === 'active',
        position: () => position(snapshot()),
        start,
        stop,
        update
    };
};

export const terrainCoordinator = { create };
