// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChildProcess } from './resource-stack.mts';

const root = fileURLToPath(new URL('../', import.meta.url));
type VerifierCommand = string[];
type VerifierExecute = (command: string, args: string[], options: { cwd: string }) => unknown;

const targets: Record<string, VerifierCommand[]> = {
    garmin: [['verify-garmin-ui.mts']],
    connections: [['verify-connections.mts']],
    chrome: [['verify-extension.mts']],
    firefox: [['verify-firefox-extension.mts']],
    browsers: [['verify-extension.mts'], ['verify-firefox-extension.mts']],
    'capture-popup': [['verify-capture-popup.mts']],
    'popup-photo-entry': [['verify-popup-photo-entry.mts']],
    'photo-output': [['verify-photo-output.mts']],
    'layout-stability': [['verify-layout-stability.mts']],
    'fixture-preflight': [['verify-fixture-preflight.mts']],
    dom: [['verify-dom.mts']],
    'gpx-header': [['verify-gpx-header.mts']],
    'multi-summit': [['verify-multi-summit.mts']],
    'draft-recovery': [['verify-draft-recovery.mts', 'chrome'], ['verify-draft-recovery.mts', 'firefox']],
    'profile-editor': [['verify-profile-editor.mts', 'chrome'], ['verify-profile-editor.mts', 'firefox']],
    'profile-units': [['verify-profile-units.mts', 'chrome'], ['verify-profile-units.mts', 'firefox']],
    instagram: [['verify-instagram.mts', 'chrome'], ['verify-instagram.mts', 'firefox']],
    'report-security': [['verify-report-security.mts', 'chrome'], ['verify-report-security.mts', 'firefox'], ['verify-report-routes.mts', 'chrome'], ['verify-report-routes.mts', 'firefox']],
    'inline-buddies': [['verify-inline-buddies.mts'], ['verify-inline-buddies.mts', '--firefox']],
    'signed-out': [['verify-signed-out.mts']],
    'capture-flow': [['verify-capture-flow.mts']],
    'capture-readiness': [['verify-capture-readiness.mts']],
    'provider-contracts': [['verify-provider-contracts.mts']],
    'provider-performance': [['verify-provider-performance.mts']],
    'map-handoffs': [['verify-map-handoffs.mts']],
    onx: [['verify-onx.mts', 'chrome'], ['verify-onx.mts', 'firefox']],
    'map-controls': [['verify-map-controls.mts'], ['verify-map-controls.mts', '--firefox']],
    'map-layers': [['verify-map-layer-control.mts'], ['verify-map-layers.mts']],
    'vector-map': [['verify-vector-map.mts'], ['verify-vector-map.mts', '--firefox']],
    'custom-overlays': [['verify-custom-overlays.mts'], ['verify-custom-overlays.mts', '--firefox']],
    'private-layers': [['verify-private-layers.mts', 'chrome'], ['verify-private-layers.mts', 'firefox']],
    'settings-navigation': [['verify-settings-fragments.mts', 'chrome'], ['verify-settings-fragments.mts', 'firefox']],
    'map-location': [['verify-ascent-weather.mts', '--map-location'], ['verify-ascent-weather.mts', '--map-location', '--firefox']],
    'api-rate-limits': [['verify-api-rate-limits.mts']],
    'ascent-backup-lifecycle': [['verify-ascent-backup-lifecycle.mts']],
    'peak-map-layout': [['verify-peak-map-layout.mts']],
    'weather-intervals': [['verify-weather-intervals.mts']],
    weather: [['verify-ascent-weather.mts'], ['verify-ascent-weather.mts', '--firefox']],
    'peak-weather': [['verify-ascent-weather.mts', '--peak'], ['verify-ascent-weather.mts', '--peak', '--firefox']],
    'air-quality': [['verify-ascent-weather.mts', '--air-quality'], ['verify-ascent-weather.mts', '--air-quality', '--firefox'], ['verify-air-quality-refresh.mts', 'chrome'], ['verify-air-quality-refresh.mts', 'firefox']],
    'summit-cloud': [['verify-summit-cloud.mts'], ['verify-summit-cloud.mts', '--firefox']],
    snow: [['verify-ascent-weather.mts', '--snow'], ['verify-ascent-weather.mts', '--snow', '--firefox']],
    'snow-depth': [['verify-snow-depth.mts', 'chrome'], ['verify-snow-depth.mts', 'firefox']],
    'snow-map': [['verify-ascent-weather.mts', '--snow-map'], ['verify-ascent-weather.mts', '--snow-map', '--firefox']],
    'peak-cards': [['verify-ascent-weather.mts', '--cards'], ['verify-ascent-weather.mts', '--cards', '--firefox']],
    'peak-card-placement': [['verify-ascent-weather.mts', '--cards-placement'], ['verify-ascent-weather.mts', '--cards-placement', '--firefox']],
    'weather-interactions': [['verify-ascent-weather.mts', '--interactions'], ['verify-ascent-weather.mts', '--interactions', '--firefox']],
    packages: [['verify-packaged-extensions.mts']],
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
