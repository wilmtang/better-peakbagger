import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
    NON_PACKAGE_NOTICES,
    VENDOR_COPY,
    distDir,
    nodeModule,
    root,
} from './build-config.mjs';

const NOTICE_FILE = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;

async function packageRootForFile(filePath) {
    let directory = path.dirname(filePath);
    while (directory !== path.dirname(directory)) {
        if (directory === root) break;
        try {
            await readFile(path.join(directory, 'package.json'), 'utf8');
            return directory;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        directory = path.dirname(directory);
    }
    return null;
}

async function packageNotice(packageRoot) {
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    const license = typeof packageJson.license === 'string'
        ? packageJson.license.trim()
        : '';
    const noticeNames = (await readdir(packageRoot))
        .filter((name) => NOTICE_FILE.test(name))
        .sort((left, right) => left.localeCompare(right));
    const notices = await Promise.all(noticeNames.map(async (name) => ({
        name,
        text: (await readFile(path.join(packageRoot, name), 'utf8')).trim(),
    })));
    const key = path.relative(root, packageRoot).split(path.sep).join('/');
    return validatePackageNoticeMetadata({
        key,
        name: packageJson.name,
        version: packageJson.version,
        license,
        licenseSource: `${key}/package.json`,
        notices,
    });
}

export function validatePackageNoticeMetadata(record) {
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

function renderRecord(record) {
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

export async function collectThirdPartyNotices({ metafiles }) {
    const packageRoots = new Set();
    const bundledInputs = metafiles.flatMap((metafile) => Object.keys(metafile.inputs));
    const runtimeInputs = [
        ...bundledInputs.map((input) => path.resolve(root, input)),
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
            licenseSource: 'reviewed override in scripts/build-config.mjs',
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

export function renderThirdPartyNotices(records) {
    return [
        'Better Peakbagger Third-Party Notices',
        '',
        'This file is generated from the npm packages and reviewed non-package assets shipped in the extension. Do not edit it by hand.',
        '',
        ...records.map(renderRecord),
        '',
    ].join('\n');
}

export async function writeThirdPartyNotices({ metafiles }) {
    const records = await collectThirdPartyNotices({ metafiles });
    const output = renderThirdPartyNotices(records);
    await writeFile(path.join(distDir, 'THIRD_PARTY_NOTICES.txt'), output);
    return { records, output };
}
