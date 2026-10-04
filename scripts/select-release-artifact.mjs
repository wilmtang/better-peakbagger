// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function selectReleaseArtifact(pages, tag, runAttempt) {
    if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
        throw new Error('Release artifact selection requires an exact release tag');
    }
    const attempt = Number(runAttempt);
    if (!/^[1-9]\d*$/.test(String(runAttempt)) || !Number.isSafeInteger(attempt)) {
        throw new Error('Release run attempt must be a positive safe integer');
    }
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page?.artifacts))) {
        throw new Error('Expected paginated release artifact listings');
    }
    const artifacts = pages.flatMap(page => page.artifacts).filter(artifact => artifact?.expired === false);
    const prefix = `browser-extension-${tag}`;
    let selected = prefix;
    let selectedAttempt = 0;
    for (const artifact of artifacts) {
        if (!artifact.name?.startsWith(`${prefix}-`)) continue;
        const suffix = artifact.name.slice(prefix.length + 1);
        const candidateAttempt = Number(suffix);
        if (/^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(candidateAttempt)
            && candidateAttempt <= attempt && candidateAttempt > selectedAttempt) {
            selected = artifact.name;
            selectedAttempt = candidateAttempt;
        }
    }
    const matches = artifacts.filter(artifact => artifact.name === selected);
    if (matches.length !== 1) {
        throw new Error(matches.length
            ? `Release artifact name is ambiguous: ${selected}`
            : `No unexpired verified package artifact found for ${tag}`);
    }
    return selected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const [tag, attempt, ...extra] = process.argv.slice(2);
        if (extra.length) throw new Error('Usage: node scripts/select-release-artifact.mjs TAG RUN_ATTEMPT');
        console.log(selectReleaseArtifact(JSON.parse(readFileSync(0, 'utf8')), tag, attempt));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
