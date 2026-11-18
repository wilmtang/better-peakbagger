// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ReviewedDependency {
    readonly packageName: string;
    readonly label: string;
    readonly shipped: boolean;
}

export interface LockPackageMetadata {
    readonly version?: string;
}

export interface PackageLockLike {
    readonly packages?: Readonly<Record<string, LockPackageMetadata>>;
}

export interface WarningBaselineEntry {
    readonly packageName?: string;
    readonly owner: string;
}

export const REVIEWED_DEPENDENCIES: Readonly<Record<string, ReviewedDependency>> = Object.freeze({
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
    svelte: { packageName: 'svelte', label: 'Svelte', shipped: true },
});

// SunCalc 2.0.1 ships its full BSD text but omits the package.json `license`
// field. Keep the exception exact so a package update has to restore metadata
// or receive an explicit review instead of silently inheriting this value.
export const REVIEWED_PACKAGE_LICENSES: Readonly<Record<string, { readonly version: string; readonly license: string }>> = Object.freeze({
    suncalc: Object.freeze({ version: '2.0.1', license: 'BSD-3-Clause' }),
});

function lockedVersion(packageLock: PackageLockLike, packageName: string): string {
    const version = packageLock.packages?.[`node_modules/${packageName}`]?.version;
    if (typeof version !== 'string' || version.trim() === '') {
        throw new Error(`package-lock.json has no resolved version for ${packageName}.`);
    }
    return version;
}

export function dependencyVersionsFromLock(packageLock: PackageLockLike): Record<string, string> {
    return Object.fromEntries(Object.entries(REVIEWED_DEPENDENCIES).map(([key, metadata]) => [
        key,
        lockedVersion(packageLock, metadata.packageName),
    ]));
}

function escaped(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactMentionVersions(text: string, label: string): string[] {
    return [...text.matchAll(new RegExp(`${escaped(label)}(?:\\s+core)?\\s+v?(\\d+\\.\\d+\\.\\d+)`, 'gi'))]
        .map((match) => match[1]);
}

function requireExactMention({ text, label, version, surface }: {
    text: string;
    label: string;
    version: string;
    surface: string;
}): void {
    const found = new Set(exactMentionVersions(text, label));
    if (found.size !== 1 || !found.has(version)) {
        throw new Error(
            `${surface} must name only ${label} ${version}; found ${[...found].join(', ') || 'none'}.`,
        );
    }
}

function requireVersionNeutralMention({ text, label, surface }: {
    text: string;
    label: string;
    surface: string;
}): void {
    if (!new RegExp(escaped(label), 'i').test(text)) {
        throw new Error(`${surface} must mention ${label}.`);
    }
    const found = new Set(exactMentionVersions(text, label));
    if (found.size) {
        throw new Error(
            `${surface} must derive ${label} versions from package-lock.json instead of hardcoding `
            + `${[...found].join(', ')}.`,
        );
    }
}

function noticeVersions(noticeInventory: string): Map<string, string> {
    const versions = new Map<string, string>();
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
}: {
    packageLock: PackageLockLike;
    approvalNotes: string;
    acknowledgements: string;
    reportEditorDocs: string;
    warningBaseline: readonly WarningBaselineEntry[];
    noticeInventory: string;
}): Record<string, string> {
    const versions = dependencyVersionsFromLock(packageLock);
    for (const [key, metadata] of Object.entries(REVIEWED_DEPENDENCIES)) {
        requireExactMention({
            text: approvalNotes,
            label: metadata.label,
            version: versions[key],
            surface: 'AMO approval notes',
        });
    }

    for (const label of [
        'Chart.js',
        'Marked',
        'MapLibre GL JS',
        'tz-lookup',
        'SunCalc',
        'TipTap',
        'Svelte',
    ]) {
        requireVersionNeutralMention({
            text: acknowledgements,
            label,
            surface: 'ACKNOWLEDGEMENTS.md',
        });
    }
    requireVersionNeutralMention({
        text: reportEditorDocs,
        label: 'Marked',
        surface: 'docs/trip-report-editor.md',
    });

    for (const warning of warningBaseline.filter((entry) => entry.packageName)) {
        lockedVersion(packageLock, warning.packageName!);
        if ('packageVersion' in warning || /\b\d+\.\d+\.\d+\b/.test(warning.owner)) {
            throw new Error(
                `web-ext warning owner ${warning.packageName} must derive its version from package-lock.json.`,
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
