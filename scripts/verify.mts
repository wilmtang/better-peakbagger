// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChildProcess } from './resource-stack.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
type VerifierCommand = string[];
type VerifierExecute = (command: string, args: string[], options: { cwd: string }) => unknown;

const targets: Record<string, VerifierCommand[]> = {
    garmin: [['verify-garmin-ui.mts']],
    connections: [['verify-connections.mjs']],
    chrome: [['verify-extension.mts']],
    firefox: [['verify-firefox-extension.mts']],
    browsers: [['verify-extension.mts'], ['verify-firefox-extension.mts']],
    'capture-popup': [['verify-capture-popup.mts']],
    'popup-photo-entry': [['verify-popup-photo-entry.mts']],
    'photo-output': [['verify-photo-output.mts']],
    'layout-stability': [['verify-layout-stability.mts']],
    'fixture-preflight': [['verify-fixture-preflight.mjs']],
    'gpx-header': [['verify-gpx-header.mjs']],
    'multi-summit': [['verify-multi-summit.mjs']],
    'draft-recovery': [['verify-draft-recovery.mjs', 'chrome'], ['verify-draft-recovery.mjs', 'firefox']],
    'profile-editor': [['verify-profile-editor.mts', 'chrome'], ['verify-profile-editor.mts', 'firefox']],
    'profile-units': [['verify-profile-units.mjs', 'chrome'], ['verify-profile-units.mjs', 'firefox']],
    instagram: [['verify-instagram.mjs', 'chrome'], ['verify-instagram.mjs', 'firefox']],
    'report-security': [['verify-report-security.mjs', 'chrome'], ['verify-report-security.mjs', 'firefox'], ['verify-report-routes.mts', 'chrome'], ['verify-report-routes.mts', 'firefox']],
    'inline-buddies': [['verify-inline-buddies.mjs'], ['verify-inline-buddies.mjs', '--firefox']],
    'signed-out': [['verify-signed-out.mjs']],
    'capture-flow': [['verify-capture-flow.mjs']],
    'capture-readiness': [['verify-capture-readiness.mjs']],
    'provider-contracts': [['verify-provider-contracts.mjs']],
    'provider-performance': [['verify-provider-performance.mjs']],
    'map-handoffs': [['verify-map-handoffs.mjs']],
    onx: [['verify-onx.mjs', 'chrome'], ['verify-onx.mjs', 'firefox']],
    'map-controls': [['verify-map-controls.mjs'], ['verify-map-controls.mjs', '--firefox']],
    'map-layers': [['verify-map-layer-control.mts'], ['verify-map-layers.mts']],
    'vector-map': [['verify-vector-map.mts'], ['verify-vector-map.mts', '--firefox']],
    'custom-overlays': [['verify-custom-overlays.mts'], ['verify-custom-overlays.mts', '--firefox']],
    'private-layers': [['verify-private-layers.mjs', 'chrome'], ['verify-private-layers.mjs', 'firefox']],
    'settings-navigation': [['verify-settings-fragments.mjs', 'chrome'], ['verify-settings-fragments.mjs', 'firefox']],
    'map-location': [['verify-ascent-weather.mjs', '--map-location'], ['verify-ascent-weather.mjs', '--map-location', '--firefox']],
    'api-rate-limits': [['verify-api-rate-limits.mjs']],
    'ascent-backup-lifecycle': [['verify-ascent-backup-lifecycle.mjs']],
    'peak-map-layout': [['verify-peak-map-layout.mjs']],
    'weather-intervals': [['verify-weather-intervals.mjs']],
    weather: [['verify-ascent-weather.mjs'], ['verify-ascent-weather.mjs', '--firefox']],
    'peak-weather': [['verify-ascent-weather.mjs', '--peak'], ['verify-ascent-weather.mjs', '--peak', '--firefox']],
    'air-quality': [['verify-ascent-weather.mjs', '--air-quality'], ['verify-ascent-weather.mjs', '--air-quality', '--firefox'], ['verify-air-quality-refresh.mts', 'chrome'], ['verify-air-quality-refresh.mts', 'firefox']],
    'summit-cloud': [['verify-summit-cloud.mjs'], ['verify-summit-cloud.mjs', '--firefox']],
    snow: [['verify-ascent-weather.mjs', '--snow'], ['verify-ascent-weather.mjs', '--snow', '--firefox']],
    'snow-depth': [['verify-snow-depth.mjs', 'chrome'], ['verify-snow-depth.mjs', 'firefox']],
    'snow-map': [['verify-ascent-weather.mjs', '--snow-map'], ['verify-ascent-weather.mjs', '--snow-map', '--firefox']],
    'peak-cards': [['verify-ascent-weather.mjs', '--cards'], ['verify-ascent-weather.mjs', '--cards', '--firefox']],
    'peak-card-placement': [['verify-ascent-weather.mjs', '--cards-placement'], ['verify-ascent-weather.mjs', '--cards-placement', '--firefox']],
    'weather-interactions': [['verify-ascent-weather.mjs', '--interactions'], ['verify-ascent-weather.mjs', '--interactions', '--firefox']],
    packages: [['verify-packaged-extensions.mjs']],
};
const terrainTargets: Record<string, VerifierCommand[]> = {
    chrome: [['verify-terrain-visual.mts']],
    firefox: [['verify-firefox-terrain.mts']],
    'cache-owners': [['verify-terrain-cache-owners.mts']],
    lod: [['verify-terrain-lod.mts']],
};

export const verificationUsage = [
    'Usage: npm run verify -- TARGET [arguments]',
    '',
    'Targets:',
    ...Object.keys(targets).map(name => `  ${name}${name === 'packages' ? ' CHROME.zip FIREFOX.zip (no build)' : ''}`),
    '  terrain [chrome|firefox|cache-owners|lod] [arguments] (default: chrome)',
    '',
    'Builds once before verification, except packages, which uses the supplied archives.',
    'Arguments are forwarded to each selected verifier. See docs/development.md for coverage.',
].join('\n');

export function verificationPlan([target, ...args]: string[]) {
    let commands: VerifierCommand[];
    if (target === 'terrain') {
        const terrain = args.shift() ?? 'chrome';
        if (!Object.hasOwn(terrainTargets, terrain)) {
            throw new Error(`Unknown terrain target: ${terrain}\n${verificationUsage}`);
        }
        commands = terrainTargets[terrain];
    } else {
        if (!Object.hasOwn(targets, target)) {
            throw new Error(`Unknown verification target: ${target ?? '(missing)'}\n${verificationUsage}`);
        }
        commands = targets[target];
    }
    if (target === 'packages' && args.length !== 2) {
        throw new Error('Usage: npm run verify -- packages CHROME.zip FIREFOX.zip');
    }
    return {
        build: target !== 'packages',
        commands: commands.map(([script, ...options]) => [path.join(root, 'scripts', script), ...options, ...args]),
    };
}

export async function runVerification(args: string[], { execute = runChildProcess as unknown as VerifierExecute } = {}) {
    const plan = verificationPlan(args);
    if (plan.build) await execute(process.execPath, [path.join(root, 'scripts/build.mts')], { cwd: root });
    for (const command of plan.commands) {
        await execute(process.execPath, command, { cwd: root });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') {
        console.log(verificationUsage);
    } else {
        runVerification(args).catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        });
    }
}
