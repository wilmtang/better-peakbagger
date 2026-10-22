// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChildProcess } from './resource-stack.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const targets = {
    chrome: [['verify-extension.mjs']],
    firefox: [['verify-firefox-extension.mjs']],
    browsers: [['verify-extension.mjs'], ['verify-firefox-extension.mjs']],
    'capture-popup': [['verify-capture-popup.mjs']],
    'layout-stability': [['verify-layout-stability.mjs']],
    'gpx-header': [['verify-gpx-header.mjs']],
    'multi-summit': [['verify-multi-summit.mjs']],
    'draft-recovery': [['verify-draft-recovery.mjs', 'chrome'], ['verify-draft-recovery.mjs', 'firefox']],
    'profile-editor': [['verify-profile-editor.mjs', 'chrome'], ['verify-profile-editor.mjs', 'firefox']],
    'inline-buddies': [['verify-inline-buddies.mjs'], ['verify-inline-buddies.mjs', '--firefox']],
    'capture-flow': [['verify-capture-flow.mjs']],
    'capture-readiness': [['verify-capture-readiness.mjs']],
    'provider-contracts': [['verify-provider-contracts.mjs']],
    'provider-performance': [['verify-provider-performance.mjs']],
    'map-handoffs': [['verify-map-handoffs.mjs']],
    'map-controls': [['verify-map-controls.mjs'], ['verify-map-controls.mjs', '--firefox']],
    'map-layers': [['verify-map-layer-control.mjs'], ['verify-map-layers.mjs']],
    'map-location': [['verify-ascent-weather.mjs', '--map-location'], ['verify-ascent-weather.mjs', '--map-location', '--firefox']],
    'api-rate-limits': [['verify-api-rate-limits.mjs']],
    'ascent-backup-lifecycle': [['verify-ascent-backup-lifecycle.mjs']],
    'peak-map-layout': [['verify-peak-map-layout.mjs']],
    'weather-intervals': [['verify-weather-intervals.mjs']],
    weather: [['verify-ascent-weather.mjs'], ['verify-ascent-weather.mjs', '--firefox']],
    'peak-weather': [['verify-ascent-weather.mjs', '--peak'], ['verify-ascent-weather.mjs', '--peak', '--firefox']],
    snow: [['verify-ascent-weather.mjs', '--snow'], ['verify-ascent-weather.mjs', '--snow', '--firefox']],
    'snow-map': [['verify-ascent-weather.mjs', '--snow-map'], ['verify-ascent-weather.mjs', '--snow-map', '--firefox']],
    'peak-cards': [['verify-ascent-weather.mjs', '--cards'], ['verify-ascent-weather.mjs', '--cards', '--firefox']],
    packages: [['verify-packaged-extensions.mjs']],
};
const terrainTargets = {
    chrome: [['verify-terrain-visual.mjs']],
    firefox: [['verify-firefox-terrain.mjs']],
    'cache-owners': [['verify-terrain-cache-owners.mjs']],
    lod: [['verify-terrain-lod.mjs']],
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

export function verificationPlan([target, ...args]) {
    let commands;
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

export async function runVerification(args, { execute = runChildProcess } = {}) {
    const plan = verificationPlan(args);
    if (plan.build) await execute(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root });
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
