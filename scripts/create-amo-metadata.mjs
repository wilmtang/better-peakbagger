import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { TERRAIN_FRAME_KEEP_ALIVE_MS } from '../src/terrain/terrain-lifecycle.js';
import { AUTHORED_SOURCE_ROOTS } from './build-config.mjs';
import { dependencyVersionsFromLock } from './dependency-metadata.mjs';

export const AMO_APPROVAL_NOTES_MAX_LENGTH = 3_000;

const terrainKeepAliveMinutes = TERRAIN_FRAME_KEEP_ALIVE_MS / 60_000;
if (!Number.isInteger(terrainKeepAliveMinutes) || terrainKeepAliveMinutes < 1) {
    throw new Error('Terrain frame keep-alive must be a positive whole number of minutes');
}

export function buildAmoMetadata({ licenseText, description, dependencyVersions }) {
    if (typeof licenseText !== 'string' || licenseText.trim() === '') {
        throw new Error('LICENSE must contain the full project license text');
    }
    if (typeof description !== 'string' || description.trim() === '') {
        throw new Error('store-assets/description.md must contain the listing description');
    }
    const requiredDependencyVersions = [
        'esbuild',
        'chart',
        'marked',
        'maplibre',
        'tzLookup',
        'sunCalc',
        'tiptap',
        'prosemirrorView',
    ];
    if (!dependencyVersions
        || requiredDependencyVersions.some((key) => !dependencyVersions[key])) {
        throw new Error('Resolved dependency versions are required for reviewer metadata');
    }
    const versions = dependencyVersions;
    const authoredRoots = AUTHORED_SOURCE_ROOTS.map(rootName => `${rootName}/`).join(', ');

    const approvalNotes = [
        `Runtime source under ${authoredRoots} is authored as ES modules. esbuild ${versions.esbuild} bundles classic browser entries as IIFEs in dist/; the terrain frame stays native ESM. web-ext packages dist/. Reproduce with \`npm ci && npm run build:release\` from the tagged source.`,
        '',
        'THIRD_PARTY_NOTICES.txt is generated from esbuild metafiles and copied runtime inputs. It records versions, licenses, notice files, SHA-256 notice hashes, and full license text for each shipped npm package, including CodeMirror/Lezer and TipTap/ProseMirror. BetaCreator symbol geometry is the only non-package override.',
        '',
        `vendor/chart.umd.min.js is unmodified Chart.js ${versions.chart} (MIT). Package: https://www.npmjs.com/package/chart.js/v/${versions.chart} ; source: https://github.com/chartjs/Chart.js/tree/v${versions.chart}`,
        '',
        `vendor/marked.umd.js is unmodified Marked ${versions.marked} (MIT). Package: https://www.npmjs.com/package/marked/v/${versions.marked} ; source: https://github.com/markedjs/marked/tree/v${versions.marked}`,
        '',
        `vendor/maplibre-gl.mjs is imported directly by the native terrain-frame module; vendor/maplibre-gl-worker.mjs, its shared module, and CSS are copied unmodified from MapLibre GL JS ${versions.maplibre} (BSD-3-Clause). Package: https://www.npmjs.com/package/maplibre-gl/v/${versions.maplibre} ; source: https://github.com/maplibre/maplibre-gl-js/tree/v${versions.maplibre}`,
        '',
        `tz-lookup ${versions.tzLookup} (CC0-1.0) is bundled unchanged into content/gpx-analyzer.js and content/ascent-editor.js for offline coordinate-to-IANA-timezone lookup. Package: https://www.npmjs.com/package/tz-lookup/v/${versions.tzLookup} ; source: https://github.com/darkskyapp/tz-lookup`,
        '',
        `SunCalc ${versions.sunCalc} (BSD-3-Clause) is bundled only into Peak-page and GPX-analyzer consumers for offline Sun/Moon positions, events, and phase. Package: https://www.npmjs.com/package/suncalc/v/${versions.sunCalc} ; source: https://github.com/mourner/suncalc/tree/v${versions.sunCalc}`,
        '',
        `The report editor bundles TipTap core ${versions.tiptap}, ProseMirror view ${versions.prosemirrorView}, and their dependency graph into content/ascent-editor.js. THIRD_PARTY_NOTICES.txt records their package metadata and licenses.`,
        '',
        `The optional 3D view is off by default. Its setting discloses external tile requests. An explicit 3D action loads elevation data (not code) from https://tiles.mapterhorn.com and may re-request the selected map layer; providers receive the viewed area and request metadata. Returning to 2D stops tile activity and parks a loaded renderer idle and non-interactive for up to ${terrainKeepAliveMinutes} minutes. After that—or immediately if startup fails or 3D is disabled—the renderer is destroyed.`,
        '',
        'Tests use synthetic data and masked Peakbagger fixtures. Live Garmin/Strava review requires an activity owned by the signed-in provider account; ambiguous ownership fails closed.',
    ].join('\n');
    if (approvalNotes.length > AMO_APPROVAL_NOTES_MAX_LENGTH) {
        throw new Error(
            `AMO approval notes exceed ${AMO_APPROVAL_NOTES_MAX_LENGTH} characters `
            + `(${approvalNotes.length})`,
        );
    }

    return {
        summary: {
            'en-US': 'Capture activities into Peakbagger drafts, with GPX analysis, ascent filters, and dark mode.',
        },
        description: {
            'en-US': description.trim(),
        },
        homepage: {
            'en-US': 'https://github.com/wilmtang/better-peakbagger',
        },
        categories: ['other'],
        version: {
            compatibility: ['firefox'],
            custom_license: {
                name: {
                    'en-US': 'GNU Affero General Public License v3.0 or later',
                },
                text: {
                    'en-US': [
                        'Better Peakbagger is licensed under the GNU Affero General Public License, version 3 or (at your option) any later version.',
                        '',
                        licenseText.trim(),
                    ].join('\n'),
                },
            },
            approval_notes: approvalNotes,
        },
    };
}

async function main() {
    const outputPath = process.argv[2];
    if (!outputPath) {
        throw new Error('Usage: node scripts/create-amo-metadata.mjs OUTPUT_PATH');
    }

    const [licenseText, description, packageLock] = await Promise.all([
        readFile('LICENSE', 'utf8'),
        readFile('store-assets/description.md', 'utf8'),
        readFile('package-lock.json', 'utf8').then(JSON.parse),
    ]);
    const metadata = buildAmoMetadata({
        licenseText,
        description,
        dependencyVersions: dependencyVersionsFromLock(packageLock),
    });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(metadata, null, 2)}\n`);
    console.log(`Wrote Firefox listing metadata to ${outputPath}.`);
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
