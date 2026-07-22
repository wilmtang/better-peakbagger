// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stable, actionable copy for live Peakbagger failures. Callers pass typed
// failures from peakbagger-request.js instead of translating transport and
// page-shape failures independently on every surface.

import { peakbaggerCloudflare as Cloudflare } from './peakbagger-cloudflare.js';

const RESOURCE_NAMES = Object.freeze({
    buddies: 'Buddy List',
    climber: 'climber page',
    edit: 'saved ascent form',
    list: 'ascent list',
    gpx: 'GPS track',
    peaks: 'nearby summit data',
    html: 'Peakbagger page',
});

const cleanDetail = value => {
    const detail = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    if (!detail || /^<(?:!doctype|html)\b/i.test(detail)) return '';
    return detail.length > 180 ? `${detail.slice(0, 179)}…` : detail;
};

const resourceName = (error, explicit) => explicit || RESOURCE_NAMES[error && error.resource] || 'Peakbagger page';

const message = (error, { resource, fallback = 'Peakbagger could not complete the request. Try again.' } = {}) => {
    const code = typeof error === 'string' ? error : error && error.code;
    const name = resourceName(error, resource);
    const status = Number(error && error.status) || 0;
    const destination = cleanDetail(error && error.redirectedTo);
    const redirected = destination ? ` (redirected to ${destination})` : '';
    const messages = {
        cloudflare: Cloudflare.copy.message,
        'signed-out': `Peakbagger could not verify your signed-in account while loading the ${name}. Sign in, then try again.`,
        network: `Better Peakbagger could not reach Peakbagger for the ${name}. Check your connection and try again.`,
        timeout: `Peakbagger took too long to return the ${name}. Try again.`,
        'response-read': `Peakbagger responded, but the ${name} could not be read. Try again.`,
        'rate-limit': 'Peakbagger is temporarily limiting requests. Wait a few minutes, then try again.',
        server: `Peakbagger is temporarily unavailable${status ? ` (HTTP ${status})` : ''}. Try again later.`,
        'not-found': `Peakbagger could not find the requested ${name}.`,
        http: `Peakbagger returned HTTP ${status || 'an error'} while loading the ${name}.`,
        'unexpected-content': `Peakbagger returned an unexpected page instead of the ${name}${redirected}. Reload Peakbagger and try again.`,
        parse: `Better Peakbagger could not parse the ${name}. Peakbagger may have changed the page.`,
        'identity-mismatch': `The ${name} belongs to a different Peakbagger account. Nothing was changed.`,
        'invalid-request': 'Better Peakbagger refused an invalid Peakbagger request.',
        storage: `The ${name} loaded, but Better Peakbagger could not save it on this device.`,
    };
    return messages[code] || fallback;
};

const recovery = (error, { url = 'https://www.peakbagger.com/', label = 'Open Peakbagger' } = {}) => {
    const code = typeof error === 'string' ? error : error && error.code;
    if (code === 'storage' || code === 'invalid-request') return null;
    if (code === 'signed-out') {
        return { label: 'Sign in to Peakbagger', href: 'https://www.peakbagger.com/Default.aspx' };
    }
    if (code === 'cloudflare') return Cloudflare.recovery({ url });
    return { label, href: url };
};

const failure = (code, details = {}) => ({ source: 'peakbagger', code, ...details });
const exception = (error, options) => Object.assign(new Error(message(error, options)), error);

export const peakbaggerError = { exception, failure, message, recovery };
