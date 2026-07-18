import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function buildAmoMetadata({ licenseText, description }) {
  if (typeof licenseText !== "string" || licenseText.trim() === "") {
    throw new Error("LICENSE must contain the full project license text");
  }
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error("store-assets/description.txt must contain the listing description");
  }

  return {
    summary: {
      "en-US": "Capture activities into Peakbagger drafts, with GPX analysis, ascent filters, and dark mode.",
    },
    description: {
      "en-US": description.trim(),
    },
    homepage: {
      "en-US": "https://github.com/wilmtang/better-peakbagger",
    },
    categories: ["other"],
    version: {
      compatibility: ["firefox"],
      custom_license: {
        name: {
          "en-US": "GNU Affero General Public License v3.0 or later",
        },
        text: {
          "en-US": [
            "Better Peakbagger is licensed under the GNU Affero General Public License, version 3 or (at your option) any later version.",
            "",
            licenseText.trim(),
          ].join("\n"),
        },
      },
      approval_notes: [
        "Runtime source under src/, options/, and popup/ is authored as ES modules. esbuild 0.28.1 bundles and minifies it into self-contained IIFEs under dist/; web-ext packages dist/. Run `npm ci && npm run build:release` from the tagged source to reproduce the runtime tree.",
        "",
        "vendor/chart.umd.min.js is copied from the unmodified Chart.js 4.5.1 npm distribution (MIT). Package: https://www.npmjs.com/package/chart.js/v/4.5.1 ; readable source: https://github.com/chartjs/Chart.js/tree/v4.5.1",
        "",
        "vendor/marked.umd.js is copied from the unmodified Marked 18.0.6 npm distribution (MIT). Package: https://www.npmjs.com/package/marked/v/18.0.6 ; readable source: https://github.com/markedjs/marked/tree/v18.0.6",
        "",
        "vendor/maplibre-gl-csp.js, vendor/maplibre-gl-csp-worker.js, and vendor/maplibre-gl.css are the unmodified MapLibre GL JS 5.24.0 distribution (BSD-3-Clause). Original package: https://www.npmjs.com/package/maplibre-gl/v/5.24.0 ; readable source: https://github.com/maplibre/maplibre-gl-js/tree/v5.24.0",
        "",
        "vendor/tz-lookup.js is an esbuild-generated browser IIFE around the tz-lookup 6.1.25 CommonJS distribution (CC0-1.0), with no application changes to its offline coordinate-to-IANA-timezone data or lookup logic. Package: https://www.npmjs.com/package/tz-lookup/v/6.1.25 ; readable source: https://github.com/darkskyapp/tz-lookup",
        "",
        "The optional 3D view is off by default. Its General setting discloses external tile requests; after it is enabled, an explicit 3D terrain action loads elevation data (not code) from https://tiles.mapterhorn.com and may re-request the selected map layer from its provider. Those services receive the viewed area and request metadata. Returning to 2D destroys the renderer.",
        "",
        "Automated tests use synthetic data and masked Peakbagger fixtures. Live Garmin/Strava capture requires the reviewer to use an activity owned by their signed-in provider account; ambiguous ownership fails closed.",
      ].join("\n"),
    },
  };
}

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) {
    throw new Error("Usage: node scripts/create-amo-metadata.mjs OUTPUT_PATH");
  }

  const [licenseText, description] = await Promise.all([
    readFile("LICENSE", "utf8"),
    readFile("store-assets/description.txt", "utf8"),
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
