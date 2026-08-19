import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { TERRAIN_FRAME_KEEP_ALIVE_MS } from '../src/terrain/terrain-lifecycle.js';
import { AUTHORED_SOURCE_ROOTS } from './build-config.mjs';
import { dependencyVersionsFromLock } from './dependency-metadata.mjs';

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
        'tiptap',
        'prosemirrorView',
    ];
    if (!dependencyVersions
        || requiredDependencyVersions.some((key) => !dependencyVersions[key])) {
        throw new Error('Resolved dependency versions are required for reviewer metadata');
    }
    const versions = dependencyVersions;
    const authoredRoots = AUTHORED_SOURCE_ROOTS.map(rootName => `${rootName}/`).join(', ');

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
            approval_notes: [
                `Runtime source under ${authoredRoots} is authored as ES modules. esbuild ${versions.esbuild} bundles and minifies classic browser entries into self-contained IIFEs under dist/; the extension-owned terrain frame remains a native ESM entry. web-ext packages dist/. Run \`npm ci && npm run build:release\` from the tagged source to reproduce the runtime tree.`,
                '',
                'The packaged THIRD_PARTY_NOTICES.txt is generated from esbuild metafiles and separately copied runtime inputs. It records the version, declared license, source notice filenames, SHA-256 notice hash, and full notice text for every shipped npm package root, including the CodeMirror/Lezer and TipTap/ProseMirror editor dependency families. The BetaCreator-derived symbol geometry is the sole reviewed non-package override.',
                '',
                `vendor/chart.umd.min.js is copied from the unmodified Chart.js ${versions.chart} npm distribution (MIT). Package: https://www.npmjs.com/package/chart.js/v/${versions.chart} ; readable source: https://github.com/chartjs/Chart.js/tree/v${versions.chart}`,
                '',
                `vendor/marked.umd.js is copied from the unmodified Marked ${versions.marked} npm distribution (MIT). Package: https://www.npmjs.com/package/marked/v/${versions.marked} ; readable source: https://github.com/markedjs/marked/tree/v${versions.marked}`,
                '',
                `vendor/maplibre-gl.mjs is imported directly by the native terrain-frame module. It, vendor/maplibre-gl-worker.mjs, vendor/maplibre-gl-shared.mjs, and vendor/maplibre-gl.css are copied unmodified from the MapLibre GL JS ${versions.maplibre} npm distribution (BSD-3-Clause). Package: https://www.npmjs.com/package/maplibre-gl/v/${versions.maplibre} ; readable source: https://github.com/maplibre/maplibre-gl-js/tree/v${versions.maplibre}`,
                '',
                `The tz-lookup ${versions.tzLookup} CommonJS distribution (CC0-1.0) is bundled by esbuild into content/gpx-analyzer.js and content/ascent-editor.js, with no application changes to its offline coordinate-to-IANA-timezone data or lookup logic. Package: https://www.npmjs.com/package/tz-lookup/v/${versions.tzLookup} ; readable source: https://github.com/darkskyapp/tz-lookup`,
                '',
                `The report editor bundles TipTap core ${versions.tiptap} and ProseMirror view ${versions.prosemirrorView} with their shipped dependency graph into content/ascent-editor.js. Their exact package metadata and license texts are recorded in THIRD_PARTY_NOTICES.txt.`,
                '',
                `The optional 3D view is off by default. Its General setting discloses external tile requests; after it is enabled, an explicit 3D terrain action loads elevation data (not code) from https://tiles.mapterhorn.com and may re-request the selected map layer from its provider. Those services receive the viewed area and request metadata. Returning to 2D stops that session's tile activity and parks a loaded renderer idle and non-interactive for up to ${terrainKeepAliveMinutes} minutes so a quick return can resume it. After that keep-alive period—or immediately if startup fails or 3D is disabled—the renderer is destroyed.`,
                '',
                'Automated tests use synthetic data and masked Peakbagger fixtures. Live Garmin/Strava capture requires the reviewer to use an activity owned by their signed-in provider account; ambiguous ownership fails closed.',
            ].join('\n'),
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
