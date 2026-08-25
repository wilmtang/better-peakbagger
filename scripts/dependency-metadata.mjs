const REVIEWED_DEPENDENCIES = Object.freeze({
    esbuild: { packageName: 'esbuild', label: 'esbuild', shipped: false },
    chart: { packageName: 'chart.js', label: 'Chart.js', shipped: true },
    marked: { packageName: 'marked', label: 'Marked', shipped: true },
    maplibre: { packageName: 'maplibre-gl', label: 'MapLibre GL JS', shipped: true },
    tzLookup: { packageName: 'tz-lookup', label: 'tz-lookup', shipped: true },
    sunCalc: { packageName: 'suncalc', label: 'SunCalc', shipped: true },
    tiptap: { packageName: '@tiptap/core', label: 'TipTap core', shipped: true },
    prosemirrorView: {
        packageName: 'prosemirror-view',
        label: 'ProseMirror view',
        shipped: true,
    },
});

// SunCalc 2.0.1 ships its full BSD text but omits the package.json `license`
// field. Keep the exception exact so a package update has to restore metadata
// or receive an explicit review instead of silently inheriting this value.
export const REVIEWED_PACKAGE_LICENSES = Object.freeze({
    suncalc: Object.freeze({ version: '2.0.1', license: 'BSD-3-Clause' }),
});

function lockedVersion(packageLock, packageName) {
    const version = packageLock.packages?.[`node_modules/${packageName}`]?.version;
    if (typeof version !== 'string' || version.trim() === '') {
        throw new Error(`package-lock.json has no resolved version for ${packageName}.`);
    }
    return version;
}

export function dependencyVersionsFromLock(packageLock) {
    return Object.fromEntries(Object.entries(REVIEWED_DEPENDENCIES).map(([key, metadata]) => [
        key,
        lockedVersion(packageLock, metadata.packageName),
    ]));
}

function escaped(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactMentionVersions(text, label) {
    return [...text.matchAll(new RegExp(`${escaped(label)}(?:\\s+core)?\\s+v?(\\d+\\.\\d+\\.\\d+)`, 'gi'))]
        .map((match) => match[1]);
}

function requireExactMention({ text, label, version, surface }) {
    const found = new Set(exactMentionVersions(text, label));
    if (found.size !== 1 || !found.has(version)) {
        throw new Error(
            `${surface} must name only ${label} ${version}; found ${[...found].join(', ') || 'none'}.`,
        );
    }
}

function noticeVersions(noticeInventory) {
    const versions = new Map();
    const records = noticeInventory.split(
        '================================================================================\n',
    );
    for (const record of records) {
        const name = /^Component: (.+)$/m.exec(record)?.[1];
        const version = /^Version: (.+)$/m.exec(record)?.[1];
        if (name && version) versions.set(name, version);
    }
    return versions;
}

export function validateReviewedDependencyMetadata({
    packageLock,
    approvalNotes,
    acknowledgements,
    reportEditorDocs,
    warningBaseline,
    noticeInventory,
}) {
    const versions = dependencyVersionsFromLock(packageLock);
    for (const [key, metadata] of Object.entries(REVIEWED_DEPENDENCIES)) {
        requireExactMention({
            text: approvalNotes,
            label: metadata.label,
            version: versions[key],
            surface: 'AMO approval notes',
        });
    }

    for (const [key, label] of [
        ['chart', 'Chart.js'],
        ['marked', 'Marked'],
        ['maplibre', 'MapLibre GL JS'],
        ['tzLookup', 'tz-lookup'],
        ['sunCalc', 'SunCalc'],
        ['tiptap', 'TipTap'],
    ]) {
        requireExactMention({
            text: acknowledgements,
            label,
            version: versions[key],
            surface: 'ACKNOWLEDGEMENTS.md',
        });
    }
    requireExactMention({
        text: reportEditorDocs,
        label: 'Marked',
        version: versions.marked,
        surface: 'docs/trip-report-editor.md',
    });

    for (const warning of warningBaseline.filter((entry) => entry.packageName)) {
        const expected = lockedVersion(packageLock, warning.packageName);
        if (warning.packageVersion !== expected) {
            throw new Error(
                `web-ext warning owner ${warning.packageName} is reviewed at ${warning.packageVersion}; `
                + `package-lock.json resolves ${expected}.`,
            );
        }
    }

    const packaged = noticeVersions(noticeInventory);
    for (const [key, metadata] of Object.entries(REVIEWED_DEPENDENCIES)) {
        if (!metadata.shipped) continue;
        if (packaged.get(metadata.packageName) !== versions[key]) {
            throw new Error(
                `THIRD_PARTY_NOTICES.txt does not contain ${metadata.packageName}@${versions[key]}.`,
            );
        }
    }
    return versions;
}
