// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
    NON_PACKAGE_NOTICES,
    VENDOR_COPY,
    distDir,
    nodeModule,
    root,
} from './build-config.mts';
import { REVIEWED_PACKAGE_LICENSES } from './dependency-metadata.mts';

export interface NoticeFileEntry {
    readonly name: string;
    readonly text: string;
}

export interface PackageNoticeRecord {
    readonly key: string;
    readonly name: string;
    readonly version: string;
    readonly license: string;
    readonly licenseSource: string;
    readonly notices: readonly NoticeFileEntry[];
}

interface PackageManifestJson {
    readonly name?: string;
    readonly version?: string;
    readonly license?: unknown;
}

const NOTICE_FILE = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;

async function packageRootForFile(filePath: string): Promise<string | null> {
    let directory = path.dirname(filePath);
    while (directory !== path.dirname(directory)) {
        if (directory === root) break;
        try {
            await readFile(path.join(directory, 'package.json'), 'utf8');
            return directory;
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        directory = path.dirname(directory);
    }
    return null;
}

async function packageNotice(packageRoot: string): Promise<PackageNoticeRecord> {
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as PackageManifestJson;
    const key = path.relative(root, packageRoot).split(path.sep).join('/');
    let license = typeof packageJson.license === 'string'
        ? packageJson.license.trim()
        : '';
    let licenseSource = `${key}/package.json`;
    if (!license && packageJson.name) {
        const reviewed = REVIEWED_PACKAGE_LICENSES[packageJson.name];
        if (reviewed?.version === packageJson.version) {
            license = reviewed.license;
            licenseSource = 'exact reviewed override in scripts/dependency-metadata.mts';
        }
    }
    const noticeNames = (await readdir(packageRoot))
        .filter((name) => NOTICE_FILE.test(name))
        .sort((left, right) => left.localeCompare(right));
    const notices = await Promise.all(noticeNames.map(async (name) => ({
        name,
        text: (await readFile(path.join(packageRoot, name), 'utf8')).trim(),
    })));
    return validatePackageNoticeMetadata({
        key,
        name: packageJson.name ?? '',
        version: packageJson.version ?? '',
        license,
        licenseSource,
        notices,
    });
}

export function validatePackageNoticeMetadata(record: PackageNoticeRecord): PackageNoticeRecord {
    if (!record.name || !record.version || !record.license || !record.licenseSource) {
        throw new Error(`Shipped package ${record.key} has incomplete name, version, license, or license-source metadata.`);
    }
    if (!Array.isArray(record.notices) || record.notices.length === 0) {
        throw new Error(`Shipped package ${record.name}@${record.version} has no resolved license or notice file.`);
    }
    if (record.notices.some(({ name, text }) => !name || !text)) {
        throw new Error(`Shipped package ${record.name}@${record.version} has an empty license or notice file.`);
    }
    return record;
}

function renderRecord(record: PackageNoticeRecord): string {
    const noticeText = record.notices
        .map(({ name, text }) => `----- ${name} -----\n${text}`)
        .join('\n\n');
    const hash = createHash('sha256').update(noticeText).digest('hex');
    return [
        '================================================================================',
        `Component: ${record.name}`,
        `Version: ${record.version}`,
        `License: ${record.license}`,
        `License metadata source: ${record.licenseSource}`,
        `Package root: ${record.key}`,
        `Notice files: ${record.notices.map(({ name }) => name).join(', ')}`,
        `Notice SHA-256: ${hash}`,
        '',
        noticeText,
    ].join('\n');
}

export async function collectThirdPartyNotices({ inputPaths }: {
    readonly inputPaths: readonly string[];
}): Promise<PackageNoticeRecord[]> {
    const packageRoots = new Set<string>();
    const runtimeInputs = [
        ...inputPaths.map((input) => path.resolve(root, input)),
        ...VENDOR_COPY.map(([input]) => nodeModule(input)),
    ];

    for (const input of runtimeInputs) {
        if (!input.split(path.sep).includes('node_modules')) continue;
        const packageRoot = await packageRootForFile(input);
        if (!packageRoot) {
            throw new Error(`Could not resolve the shipped npm package that owns ${path.relative(root, input)}.`);
        }
        packageRoots.add(packageRoot);
    }

    const packageRecords = await Promise.all([...packageRoots].map(packageNotice));
    const overrideRecords = await Promise.all(NON_PACKAGE_NOTICES.map(async (override) =>
        validatePackageNoticeMetadata({
            ...override,
            key: `reviewed-override:${override.key}`,
            licenseSource: 'reviewed override in scripts/build-config.mts',
            notices: [{
                name: override.noticeFile,
                text: (await readFile(path.join(root, override.noticeFile), 'utf8')).trim(),
            }],
        })));
    const records = [...packageRecords, ...overrideRecords].sort((left, right) =>
        left.name.localeCompare(right.name)
        || left.version.localeCompare(right.version)
        || left.key.localeCompare(right.key));
    return records;
}

export function renderThirdPartyNotices(records: readonly PackageNoticeRecord[]): string {
    return [
        'Better Peakbagger Third-Party Notices',
        '',
        'This file is generated from the npm packages and reviewed non-package assets shipped in the extension. Do not edit it by hand.',
        '',
        ...records.map(renderRecord),
        '',
    ].join('\n');
}

export async function writeThirdPartyNotices({ inputPaths, outputDir = distDir }: {
    readonly inputPaths: readonly string[];
    readonly outputDir?: string;
}): Promise<{ readonly records: PackageNoticeRecord[]; readonly output: string }> {
    const records = await collectThirdPartyNotices({ inputPaths });
    const output = renderThirdPartyNotices(records);
    await writeFile(path.join(outputDir, 'THIRD_PARTY_NOTICES.txt'), output);
    return { records, output };
}
