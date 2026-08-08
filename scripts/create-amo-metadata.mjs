import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function buildAmoMetadata({ licenseText, description }) {
    if (typeof licenseText !== 'string' || licenseText.trim() === '') {
        throw new Error('LICENSE must contain the full project license text');
    }
    if (typeof description !== 'string' || description.trim() === '') {
        throw new Error('store-assets/description.md must contain the listing description');
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
            approval_notes: [
                'Runtime source under src/, options/, and popup/ is authored as ES modules. esbuild 0.28.1 bundles and minifies classic browser entries into self-contained IIFEs under dist/; the extension-owned terrain frame remains a native ESM entry. web-ext packages dist/. Run `npm ci && npm run build:release` from the tagged source to reproduce the runtime tree.',
                '',
                'The packaged THIRD_PARTY_NOTICES.txt is generated from esbuild metafiles and separately copied runtime inputs. It records the version, declared license, source notice filenames, SHA-256 notice hash, and full notice text for every shipped npm package root, including the CodeMirror/Lezer and TipTap/ProseMirror editor dependency families. The BetaCreator-derived symbol geometry is the sole reviewed non-package override.',
                '',
                'vendor/chart.umd.min.js is copied from the unmodified Chart.js 4.5.1 npm distribution (MIT). Package: https://www.npmjs.com/package/chart.js/v/4.5.1 ; readable source: https://github.com/chartjs/Chart.js/tree/v4.5.1',
                '',
                'vendor/marked.umd.js is copied from the unmodified Marked 18.0.6 npm distribution (MIT). Package: https://www.npmjs.com/package/marked/v/18.0.6 ; readable source: https://github.com/markedjs/marked/tree/v18.0.6',
                '',
                'vendor/maplibre-gl.mjs is imported directly by the native terrain-frame module. It, vendor/maplibre-gl-worker.mjs, vendor/maplibre-gl-shared.mjs, and vendor/maplibre-gl.css are copied unmodified from the MapLibre GL JS 6.2.0 npm distribution (BSD-3-Clause). Package: https://www.npmjs.com/package/maplibre-gl/v/6.2.0 ; readable source: https://github.com/maplibre/maplibre-gl-js/tree/v6.2.0',
                '',
                'The tz-lookup 6.1.25 CommonJS distribution (CC0-1.0) is bundled by esbuild into content/gpx-analyzer.js and content/ascent-editor.js, with no application changes to its offline coordinate-to-IANA-timezone data or lookup logic. Package: https://www.npmjs.com/package/tz-lookup/v/6.1.25 ; readable source: https://github.com/darkskyapp/tz-lookup',
                '',
                'The optional 3D view is off by default. Its General setting discloses external tile requests; after it is enabled, an explicit 3D terrain action loads elevation data (not code) from https://tiles.mapterhorn.com and may re-request the selected map layer from its provider. Those services receive the viewed area and request metadata. Returning to 2D destroys the renderer.',
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

    const [licenseText, description] = await Promise.all([
        readFile('LICENSE', 'utf8'),
        readFile('store-assets/description.md', 'utf8'),
    ]);
    const metadata = buildAmoMetadata({ licenseText, description });
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
