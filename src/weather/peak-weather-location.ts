// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readMapPoint } from '../maps/map-location-menu.ts';

export interface WeatherLocationPoint {
    latitude: number;
    longitude: number;
}

export interface WeatherLocationSelection extends WeatherLocationPoint {
    elevation: null;
}

export interface WeatherLocationMenuOptions {
    enabled: () => boolean;
    canSelect?: () => boolean;
    onSelect: (point: WeatherLocationSelection) => void;
}

export interface WeatherLocationMenu {
    updateAvailability(): void;
    close(): void;
    dispose(): void;
}

export const weatherLocationLabel = (point: WeatherLocationPoint): string =>
    `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`;

// The shared MAIN-world menu owns presentation and elevation. The isolated
// weather card accepts only a validated selection; it still owns every request.
export function createWeatherLocationMenu({ enabled, canSelect = () => true, onSelect }: WeatherLocationMenuOptions): WeatherLocationMenu {
    const card = document.getElementById('bpb-peak-weather');
    const changed = () => document.dispatchEvent(new Event('bpb-map-weather-change'));
    const updateAvailability = () => {
        if (card) card.dataset.bpbMapWeather = enabled() ? canSelect() ? 'ready' : 'limited' : '';
        changed();
    };
    const receive = (event: MessageEvent) => {
        const data = event.data as Record<string, unknown> | null | undefined;
        if (event.source !== window || event.origin !== location.origin || data?.__bpbPeakWeather !== true
            || data.type !== 'select' || !enabled() || !canSelect()) return;
        const point = readMapPoint(data);
        if (point) onSelect({ latitude: point.latitude, longitude: point.longitude, elevation: null });
    };
    window.addEventListener('message', receive);
    return { updateAvailability,
        close() { updateAvailability(); document.dispatchEvent(new Event('bpb-map-menu-close')); },
        dispose() { window.removeEventListener('message', receive); if (card) delete card.dataset.bpbMapWeather; changed(); },
    };
}
