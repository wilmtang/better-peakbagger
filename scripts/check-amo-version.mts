import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const AMO_API_ROOT = 'https://addons.mozilla.org/api/v5/addons/addon/';
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type AmoJwtInput = {
    issuer?: string;
    secret?: string;
    nowSeconds: number;
    jwtId?: string;
};

export type InspectAmoVersionInput = {
    addonId: unknown;
    version?: string;
    issuer?: string;
    secret?: string;
    fetchImpl?: typeof fetch;
    nowSeconds?: number;
};

export type AmoVersionInspection =
    | { state: 'unused'; version: string }
    | {
        state: 'present';
        version: string | undefined;
        channel: string | undefined;
        fileStatus: string | undefined;
    };

type AmoVersionDetail = {
    version?: string;
    channel?: string;
    file?: { status?: string };
};

function base64UrlJson(value: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function createAmoJwt({ issuer, secret, nowSeconds, jwtId = randomUUID() }: AmoJwtInput): string {
    if (!issuer || !secret) throw new Error('AMO API credentials are required');
    const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
    const payload = base64UrlJson({
        iss: issuer,
        jti: jwtId,
        iat: nowSeconds,
        exp: nowSeconds + 60,
    });
    const unsigned = `${header}.${payload}`;
    const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
    return `${unsigned}.${signature}`;
}

export async function inspectAmoVersion({
    addonId,
    version,
    issuer,
    secret,
    fetchImpl = fetch,
    nowSeconds = Math.floor(Date.now() / 1_000),
}: InspectAmoVersionInput): Promise<AmoVersionInspection> {
    if (typeof addonId !== 'string' || addonId.trim() === '') {
        throw new Error('A stable Firefox add-on ID is required');
    }
    if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
        throw new Error(`Firefox version ${JSON.stringify(version)} must be exact semver`);
    }
    const url = new URL(
        `${encodeURIComponent(addonId)}/versions/v${encodeURIComponent(version)}/`,
        AMO_API_ROOT,
    );
    const response = await fetchImpl(url, {
        headers: {
            Accept: 'application/json',
            Authorization: `JWT ${createAmoJwt({ issuer, secret, nowSeconds })}`,
        },
        signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return { state: 'unused', version };
    if (!response.ok) {
        throw new Error(`AMO version lookup failed with HTTP ${response.status}`);
    }
    const detail = await response.json() as AmoVersionDetail;
    return {
        state: 'present',
        version: detail.version,
        channel: detail.channel,
        fileStatus: detail.file?.status,
    };
}

async function main(): Promise<void> {
    const version = process.argv[2];
    const requireUnused = process.argv.includes('--require-unused');
    const manifest = JSON.parse(await readFile('manifest.json', 'utf8')) as {
        browser_specific_settings?: { gecko?: { id?: unknown } };
    };
    const result = await inspectAmoVersion({
        addonId: manifest.browser_specific_settings?.gecko?.id,
        version,
        issuer: process.env.WEB_EXT_API_KEY,
        secret: process.env.WEB_EXT_API_SECRET,
    });
    console.log(JSON.stringify(result));
    if (requireUnused && result.state !== 'unused') {
        throw new Error(
            `AMO version ${version} already exists (${result.fileStatus || 'unknown status'}); `
            + 'refusing to submit it again',
        );
    }
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
