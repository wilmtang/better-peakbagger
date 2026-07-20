// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — GitHub ascent-backup payload builder (pure).
//
// Turns one save-time ascent snapshot into the files of a single backup folder:
// report.md (the trip report as real Markdown), ascent.json (every structured
// field the user entered, plus peak metadata and provenance, versioned from the
// start), and Peakbagger's stored track.gpx when one exists. It also owns the
// folder-slug rules and the commit-message text.
//
// This module has no DOM or extension-API dependency: it is browser-API-free so
// the background worker (where there is no DOMParser) can build the commit
// payload without coupling the serialization to network, tokens, or messaging.
// The report body arrives already as Markdown in `report.markdown` — the
// content script, which does have a DOM and the Markdown parser, resolves the
// exact Markdown sidecar vs a bracket-markup conversion (via src/report-markup.js)
// before the snapshot reaches here. See docs/github-ascent-backup.md for the
// design and the snapshot contract summarized below.
//
// Snapshot contract (the shape this module consumes; the content script and
// background worker produce it and are the single owners of the Peakbagger-DOM
// field-name mapping):
//
//   {
//     ascent: {
//       id,                       // number, required — the stable identity
//       date,                     // 'YYYY-MM-DD' (partial 'YYYY-MM-00'/'YYYY-00-00'
//                                 //  or '' / null = undated), degrades gracefully
//       suffix,                   // same-day alphabetical suffix, '' when none
//       type, route, routeDown, externalUrl, // strings, omitted when blank
//       gainFt, lossFt, distanceUpMi, distanceDnMi, extraGainFt, extraLossFt,
//       timeUp, timeDn, nightsOut, startFt, endFt, pointFt, quality,
//       gear: [string],           // omitted when empty
//       companions: { registered: [{ id?, name }], others },
//       weather: { precip, temperature, wind, visibility, description }
//     },
//     peak: { id, name, elevationFt, location },
//     report: { markdown }        // the final Markdown body (sidecar-verbatim
//                                 //  or bracket→Markdown), resolved upstream
//     backup: { extensionVersion, syncedAt }   // syncedAt is caller-stamped
//   }
//
// Numeric fields accept the raw string the form held ("9000", "8.0"); this
// module coerces them and omits anything blank or unparseable rather than
// inventing a value. Idempotent: safe to inject more than once into the global.

    const SCHEMA_VERSION = 1;

    // Peakbagger's public URLs are deterministic from the numeric ids, so they
    // are derived here rather than trusted from the snapshot.
    const ascentUrl = id => `https://peakbagger.com/climber/ascent.aspx?aid=${id}`;
    const peakUrl = id => `https://peakbagger.com/peak.aspx?pid=${id}`;

    const trimString = value => (typeof value === 'string' ? value : value == null ? '' : String(value)).trim();

    // A form value coerced to a finite number, or undefined when blank/garbage.
    // Commas and surrounding whitespace are stripped so "9,000" reads as 9000.
    const toNumber = value => {
        if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
        const cleaned = trimString(value).replace(/,/g, '');
        if (!cleaned) return undefined;
        const parsed = Number(cleaned);
        return Number.isFinite(parsed) ? parsed : undefined;
    };

    // Set key only when the string is non-blank; never invent an empty field.
    const setString = (target, key, value) => {
        const text = trimString(value);
        if (text) target[key] = text;
    };

    const setNumber = (target, key, value) => {
        const num = toNumber(value);
        if (num !== undefined) target[key] = num;
    };

    // ---- Dates -------------------------------------------------------------

    // The known leading components of a possibly-partial Peakbagger date. A
    // zero month or day (Peakbagger's "unknown" marker) truncates the value so
    // partial dates degrade gracefully instead of pretending precision.
    const dateParts = date => {
        const match = trimString(date).match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
        if (!match) return [];
        const [, year, month, day] = match;
        if (!year || year === '0000') return [];
        const parts = [year];
        if (month && month !== '00') {
            parts.push(month);
            if (day && day !== '00') parts.push(day);
        }
        return parts;
    };

    // Folder-name date prefix: full 'YYYY-MM-DD', partial 'YYYY-MM'/'YYYY', or
    // the literal 'undated' when nothing is known.
    const datePrefix = date => {
        const parts = dateParts(date);
        return parts.length ? parts.join('-') : 'undated';
    };

    // The same value for machine fields, but undated becomes null rather than a
    // magic string.
    const isoDate = date => {
        const parts = dateParts(date);
        return parts.length ? parts.join('-') : null;
    };

    // ---- Slugs -------------------------------------------------------------

    // A filesystem- and URL-safe peak slug: strip diacritics, lowercase, and
    // collapse every non-alphanumeric run to a single hyphen. Capped so an
    // unusually long name cannot dominate the folder path. Falls back to 'peak'
    // when a name is entirely non-Latin.
    const peakSlug = name => {
        const slug = trimString(name)
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60)
            .replace(/-+$/, '');
        return slug || 'peak';
    };

    // The backup folder leaf: date first for human sorting, the a<ascentId>
    // suffix last as the stable identity across peak/date edits.
    const folderName = snapshot => {
        const ascent = (snapshot && snapshot.ascent) || {};
        const peak = (snapshot && snapshot.peak) || {};
        return `${datePrefix(ascent.date)}-${peakSlug(peak.name)}-a${ascent.id}`;
    };

    // Backups are intentionally first-class folders at the repository root.
    // Keeping the stable ascent id in every leaf makes that flat layout safe to
    // scan and keeps a dedicated backup repository pleasant to browse.
    const folderPath = snapshot => folderName(snapshot);

    const BACKUP_FOLDER_PATTERN = /^(?:undated|\d{4}(?:-\d{2}){0,2})-[a-z0-9](?:[a-z0-9-]{0,59})-a\d+$/;
    const isBackupFolderName = name => typeof name === 'string' && BACKUP_FOLDER_PATTERN.test(name);

    // Find an already-committed folder for this ascent regardless of its slug,
    // so a re-save after a date or peak edit re-syncs the same ascent instead
    // of leaving a stale duplicate. Matches only the exact a<ascentId> leaf
    // suffix, so ascent 123 never collides with 1234.
    const matchExistingFolder = (names, ascentId) => {
        if (!Array.isArray(names) || ascentId == null) return null;
        const suffix = `-a${ascentId}`;
        return names.find(name => isBackupFolderName(name) && name.endsWith(suffix)) || null;
    };

    // ---- ascent.json -------------------------------------------------------

    const buildCompanions = companions => {
        const source = companions && typeof companions === 'object' ? companions : {};
        const registered = Array.isArray(source.registered)
            ? source.registered
                .map(entry => {
                    if (!entry || typeof entry !== 'object') return null;
                    const name = trimString(entry.name);
                    if (!name) return null;
                    const person = { name };
                    const id = toNumber(entry.id);
                    if (id !== undefined) person.id = id;
                    return person;
                })
                .filter(Boolean)
            : [];
        const others = trimString(source.others);
        if (!registered.length && !others) return undefined;
        const result = {};
        if (registered.length) result.registered = registered;
        if (others) result.others = others;
        return result;
    };

    const buildWeather = weather => {
        const source = weather && typeof weather === 'object' ? weather : {};
        const result = {};
        setString(result, 'precip', source.precip);
        setString(result, 'temperature', source.temperature);
        setString(result, 'wind', source.wind);
        setString(result, 'visibility', source.visibility);
        setString(result, 'description', source.description);
        return Object.keys(result).length ? result : undefined;
    };

    // Serialize the snapshot into the versioned ascent.json object. Blank
    // scalars are omitted; only the identity fields (id, url, date, suffix) and
    // the peak/backup blocks are always present.
    const buildAscentJson = snapshot => {
        const src = (snapshot && snapshot.ascent) || {};
        const peakSrc = (snapshot && snapshot.peak) || {};
        const backupSrc = (snapshot && snapshot.backup) || {};

        const ascent = {
            id: src.id,
            url: ascentUrl(src.id),
            date: isoDate(src.date),
            suffix: trimString(src.suffix),
        };
        setString(ascent, 'type', src.type);
        setString(ascent, 'route', src.route);
        setString(ascent, 'routeDown', src.routeDown);
        setString(ascent, 'externalUrl', src.externalUrl);
        setNumber(ascent, 'gainFt', src.gainFt);
        setNumber(ascent, 'lossFt', src.lossFt);
        setNumber(ascent, 'distanceUpMi', src.distanceUpMi);
        setNumber(ascent, 'distanceDnMi', src.distanceDnMi);
        setNumber(ascent, 'extraGainFt', src.extraGainFt);
        setNumber(ascent, 'extraLossFt', src.extraLossFt);
        setString(ascent, 'timeUp', src.timeUp);
        setString(ascent, 'timeDn', src.timeDn);
        setNumber(ascent, 'nightsOut', src.nightsOut);
        setNumber(ascent, 'startFt', src.startFt);
        setNumber(ascent, 'endFt', src.endFt);
        setNumber(ascent, 'pointFt', src.pointFt);
        setNumber(ascent, 'quality', src.quality);

        const gear = Array.isArray(src.gear)
            ? src.gear.map(trimString).filter(Boolean)
            : [];
        if (gear.length) ascent.gear = gear;

        const companions = buildCompanions(src.companions);
        if (companions) ascent.companions = companions;

        const weather = buildWeather(src.weather);
        if (weather) ascent.weather = weather;

        const peak = {
            id: peakSrc.id,
            url: peakSrc.id == null ? undefined : peakUrl(peakSrc.id),
            name: trimString(peakSrc.name) || undefined,
        };
        setNumber(peak, 'elevationFt', peakSrc.elevationFt);
        setString(peak, 'location', peakSrc.location);
        for (const key of Object.keys(peak)) if (peak[key] === undefined) delete peak[key];

        return {
            schemaVersion: SCHEMA_VERSION,
            ascent,
            peak,
            backup: {
                syncedAt: trimString(backupSrc.syncedAt) || null,
                extensionVersion: trimString(backupSrc.extensionVersion) || null,
            },
        };
    };

    // ---- report.md ---------------------------------------------------------

    // A double-quoted YAML scalar, escaping the two characters that would break
    // the quoting. Keeps the frontmatter valid for names with colons or quotes.
    const yamlString = value => `"${trimString(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

    // The report body, already resolved to Markdown upstream: the exact
    // Markdown-source sidecar when the user authored in Markdown, otherwise the
    // submitted bracket markup converted through src/report-markup.js. That
    // conversion needs a DOM, so it runs in the content script, not here.
    const reportBody = report => {
        const markdown = report && typeof report === 'object' ? report.markdown : '';
        return typeof markdown === 'string' ? markdown : '';
    };

    // report.md: a short self-describing frontmatter block (peak, date,
    // Peakbagger URL) followed by the trip report as real Markdown.
    const buildReportMarkdown = snapshot => {
        const ascent = (snapshot && snapshot.ascent) || {};
        const peak = (snapshot && snapshot.peak) || {};
        const front = ['---'];
        const name = trimString(peak.name);
        if (name) front.push(`peak: ${yamlString(name)}`);
        const date = isoDate(ascent.date);
        if (date) front.push(`date: ${date}`);
        if (ascent.id != null) front.push(`peakbagger: ${ascentUrl(ascent.id)}`);
        front.push('---');

        const body = reportBody(snapshot && snapshot.report).replace(/\s+$/, '');
        const parts = [front.join('\n')];
        if (body) parts.push(body);
        return `${parts.join('\n\n')}\n`;
    };

    // ---- Files and commit --------------------------------------------------

    // The leaf files for one backup folder. track.gpx is included only when
    // Peakbagger stored a track for the ascent.
    const buildFiles = (snapshot, options = {}) => {
        const files = [
            { name: 'report.md', content: buildReportMarkdown(snapshot) },
            { name: 'ascent.json', content: `${JSON.stringify(buildAscentJson(snapshot), null, 2)}\n` },
        ];
        const gpx = options.gpx;
        if (typeof gpx === 'string' && gpx.trim()) {
            files.push({ name: 'track.gpx', content: gpx });
        }
        return files;
    };

    // One human date for the commit subject; the folder prefix rules, minus the
    // 'undated' placeholder, which reads better simply omitted from a sentence.
    const commitDate = date => {
        const prefix = datePrefix(date);
        return prefix === 'undated' ? '' : prefix;
    };

    // "Add ascent: Mount Rainier, 2026-07-12" — or "Update ascent: …" on a
    // re-sync. The date is dropped when unknown.
    const commitSubject = (snapshot, options = {}) => {
        const ascent = (snapshot && snapshot.ascent) || {};
        const peak = (snapshot && snapshot.peak) || {};
        const verb = options.update ? 'Update' : 'Add';
        const name = trimString(peak.name) || 'ascent';
        const date = commitDate(ascent.date);
        return `${verb} ascent: ${name}${date ? `, ${date}` : ''}`;
    };

    // The full logical commit payload for the GitHub client. `existingFolders`
    // is the list of backup leaf names already found by the client; a matching
    // a<ascentId> folder makes this an Update and, when its slug changed, names
    // the old root folder for atomic removal in the same commit.
    const buildBackup = (snapshot, options = {}) => {
        const ascent = (snapshot && snapshot.ascent) || {};
        const leaf = folderName(snapshot);
        const folder = leaf;
        const existingLeaf = matchExistingFolder(options.existingFolders, ascent.id);
        const isUpdate = existingLeaf != null;
        const previousFolder = existingLeaf && existingLeaf !== leaf
            ? existingLeaf
            : null;
        return {
            isUpdate,
            folder,
            previousFolder,
            message: commitSubject(snapshot, { update: isUpdate }),
            files: buildFiles(snapshot, options).map(file => ({
                path: `${folder}/${file.name}`,
                content: file.content,
            })),
        };
    };

    const API = {
        SCHEMA_VERSION,
        peakSlug,
        datePrefix,
        isoDate,
        folderName,
        folderPath,
        isBackupFolderName,
        matchExistingFolder,
        buildAscentJson,
        buildReportMarkdown,
        buildFiles,
        commitSubject,
        buildBackup,
    };

    export const githubBackup = API;
