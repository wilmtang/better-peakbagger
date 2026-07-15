import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function buildAmoMetadata(licenseText) {
  if (typeof licenseText !== "string" || licenseText.trim() === "") {
    throw new Error("LICENSE must contain the full project license text");
  }

  return {
    summary: {
      "en-US": "Capture activities into Peakbagger drafts, with GPX analysis, ascent filters, and dark mode.",
    },
    description: {
      "en-US": [
        "Better Peakbagger streamlines trip planning and ascent logging on Peakbagger.",
        "",
        "It can turn an owned Garmin or Strava activity into confidence-ranked Peakbagger drafts, analyze ascent GPX tracks in 2D or opt-in 3D terrain, filter and sort ascent lists, and apply a site-wide dark theme. Drafts always stop for manual review before Save.",
        "",
        "Raw provider GPX stays on the activity page. When the user explicitly starts capture, small coordinate corridor boxes are sent to Peakbagger to find nearby summits. If the user opens drafts, a newly serialized, reduced coordinate GPX is sent to Peakbagger Preview. Waypoint coordinates and names are included by default and can be turned off; all other waypoint fields remain excluded.",
      ].join("\n"),
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
        "This is a build-free extension. web-ext packages the checked-in JavaScript without transpilation, bundling, or minification.",
        "",
        "vendor/chart.umd.min.js is the unmodified Chart.js 4.5.1 distribution (MIT). Original distribution: https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js ; readable source: https://github.com/chartjs/Chart.js/tree/v4.5.1",
        "",
        "vendor/maplibre-gl-csp.js, vendor/maplibre-gl-csp-worker.js, and vendor/maplibre-gl.css are the unmodified MapLibre GL JS 5.24.0 distribution (BSD-3-Clause). Original package: https://www.npmjs.com/package/maplibre-gl/v/5.24.0 ; readable source: https://github.com/maplibre/maplibre-gl-js/tree/v5.24.0",
        "",
        "The optional 3D view loads elevation data (not code) from https://tiles.mapterhorn.com only after an in-page notice and explicit Load 3D terrain action. It sends tile coordinates for the viewed area. Returning to 2D destroys the renderer.",
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

  const metadata = buildAmoMetadata(await readFile("LICENSE", "utf8"));
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
