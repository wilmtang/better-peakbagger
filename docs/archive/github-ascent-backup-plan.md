# GitHub ascent backup: implementation record

> Archived plan. The feature is implemented; the maintained design lives in
> [github-ascent-backup.md](../github-ascent-backup.md), and release-only live
> checks live in [releasing.md](../releasing.md).

The implementation landed as focused units rather than one cross-cutting
change:

1. The pure `src/github/github-backup.js` payload module established folder slugs,
   versioned `ascent.json`, Markdown selection, and commit-message rules.
2. The pure `src/github/github-client.js` added repository preflight, marker and
   folder discovery, empty-repository initialization, atomic Git Data commits,
   owned-file-only renames, and bounded conflict retries.
3. `src/github/github-auth.js` added GitHub App device flow and the
   `storage.local`-only credential/repository accessor. The worker, not the
   options page or a content script, owns the token.
4. The options UI added the explicit feature gate, optional host-permission
   request, device code, installation handoff, repository discovery and
   inspection, connection state, and disconnect behavior.
5. `src/ascent/ascent-snapshot.js` added the save-time form/report snapshot. Only Save
   and implicit Save submission create one; Preview does not.
6. `src/ascent/ascent-page.js` and `src/ascent/ascent-backup.js` added the owner-only saved
   ascent reader, stored-GPX fetch, user-facing manual backup state, and worker
   handoff.
7. Fixture, pure-client, options, surface, and bundled-worker integration tests
   pinned the gates and payloads without contacting GitHub or live Peakbagger.
8. Manifest and privacy work added the optional GitHub hosts, packaged
   disclosures, and Firefox data-collection review.
9. A separate `autoGithubBackup` opt-in reused the same visible path and
   required a fresh precise save snapshot.
10. Full-profile backfill later reused the repository format and serialized
    writer. Its original plan is archived in
    [full-profile-backup.md](full-profile-backup.md); current batching and
    backpressure live in the
    [GitHub backup design](../github-ascent-backup.md#full-profile-producer-consumer-pipeline).

Automated unit, bundle, real-extension, and package checks are part of the
current verification matrix. The following remain manual pre-release checks
because they need signed-in user sessions and live services:

- authorize and install the registered GitHub App through real device flow;
- save one controlled ascent on live Peakbagger in Chrome and Firefox;
- confirm the redirect identity and stored-GPX link timing assumed by
  `src/ascent/ascent-page.js`;
- confirm one commit lands in a scratch repository; and
- run one minimal, rate-limited profile backup without attempting to trigger or
  automate a Cloudflare challenge.

Two decisions remain intentionally outside the feature:

- A delayed or absent saved-GPX link produces a report-and-JSON backup rather
  than blocking the backup.
- Deleted Peakbagger ascents are not deleted from GitHub. The repository is an
  archive, not a mirror.
