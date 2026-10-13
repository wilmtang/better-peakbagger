// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Locally reviewed navigation destinations, not forecast coverage polygons.
// Source evidence and deliberate omissions: docs/plans/avalanche-forecast-links-and-layer.md.
// Reviewed October 12, 2026. No remote registry, forecast fetch, or zone inference.
const providers = [
    { id: 'us', name: 'Avalanche.org', kind: 'aggregator',
        countries: ['united states'], href: 'https://avalanche.org/' },
    { id: 'ca', name: 'Avalanche Canada', kind: 'professional',
        countries: ['canada'], href: 'https://avalanche.ca/map', navigation: 'canada' },
    { id: 'eaws', name: 'EAWS bulletin map', kind: 'aggregator',
        countries: ['andorra', 'austria', 'czech republic', 'finland', 'france', 'germany',
            'italy', 'poland', 'slovakia', 'slovenia', 'spain', 'sweden', 'ukraine'],
        href: 'https://eaws-bulletin-map.legner.me/', navigation: 'eaws' },
    // Romania is in the member directory but absent from the map's default
    // region list. Membership alone must not promise machine-readable data.
    { id: 'eaws-directory', name: 'EAWS issuing services', kind: 'aggregator',
        countries: ['romania'], href: 'https://www.avalanches.org/about/#members' },
    { id: 'ch', name: 'White Risk (SLF)', kind: 'government',
        countries: ['switzerland'], href: 'https://whiterisk.ch/en/conditions' },
    { id: 'no', name: 'Varsom', kind: 'government',
        countries: ['norway'], href: 'https://www.varsom.no/en/avalanches/avalanche-warnings/' },
    { id: 'is', name: 'Icelandic Met Office', kind: 'government',
        countries: ['iceland'], href: 'https://gottvedur.is/snjoflod/en/' },
    { id: 'gb', name: 'SAIS (Scotland)', kind: 'professional',
        countries: ['united kingdom'], href: 'https://www.sais.gov.uk/',
        detail: 'Find a regional bulletin for Scotland.' },
    { id: 'nz', name: 'NZ Avalanche Advisory', kind: 'professional',
        countries: ['new zealand'], href: 'https://www.avalanche.net.nz/' },
    { id: 'jp', name: 'Japan Avalanche Network', kind: 'professional',
        countries: ['japan'], href: 'https://data.nadare.jp/avalanche_informations/?locale=ja' },
    { id: 'au', name: 'Mountain Safety Collective', kind: 'professional',
        countries: ['australia'], href: 'https://mountainsafetycollective.org/backcountry-conditions-reports',
        label: 'Backcountry conditions', detail: 'Find alpine conditions reports for Victoria and New South Wales.' },
];
const byCountry = new Map(providers.flatMap(provider => provider.countries.map(country => [country, provider])));

function destination(provider, latitude, longitude) {
    const url = new URL(provider.href);
    if (provider.navigation === 'canada') {
        url.searchParams.set('lat', String(latitude));
        url.searchParams.set('lng', String(longitude));
    } else if (provider.navigation === 'eaws') {
        const west = longitude - .3, east = longitude + .3;
        // The provider's Mercator view cannot represent a wrapped box or a
        // polar summit. Use its gateway rather than fitting a misleading area.
        if (west < -180 || east > 180 || Math.abs(latitude) > 85) return 'https://www.avalanches.org/';
        const south = Math.max(-85, latitude - .3), north = Math.min(85, latitude + .3);
        url.searchParams.set('bbox', [west, south, east, north].map(value => value.toFixed(6)).join(','));
    }
    return url.href;
}

export function resolveAvalancheLinks({ nations, latitude, longitude }) {
    if (!Array.isArray(nations) || nations.length > 8
        || !Number.isFinite(latitude) || Math.abs(latitude) > 90
        || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
        return { links: [], unconfigured: true };
    }
    const seen = new Set(), links = [];
    let unconfigured = nations.length === 0;
    for (const nation of nations) {
        const provider = byCountry.get(nation);
        if (!provider) { unconfigured = true; continue; }
        if (seen.has(provider.id)) continue;
        seen.add(provider.id);
        links.push({ id: provider.id, kind: provider.kind,
            label: `${provider.label || 'Avalanche forecasts'} — ${provider.name}`,
            detail: provider.detail || 'Find the regional bulletin for this peak.',
            href: destination(provider, latitude, longitude) });
    }
    return { links, unconfigured };
}
