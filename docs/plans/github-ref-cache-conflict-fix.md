# Fix plan: profile backup "repository changed" conflict from HTTP-cached ref reads

Full-profile backup runs still pause with "The repository changed while the
backup was being committed. Try the backup again." even though no external
writer touched the repository. This plan records the root cause and the
approved fix.

## Root cause

The batch commit path reads the branch head through the browser's HTTP cache.

1. `netFetch` in `src/background.js` is plain `fetch(url, init)`, and
   `request()` in `src/github-client.js` never sets `cache`. The default
   `cache: 'default'` honors the browser HTTP cache. GitHub's REST API serves
   authenticated GETs with `Cache-Control: private, max-age=60, s-maxage=60`,
   so `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` is stored and served
   *without revalidation* for 60 seconds. (`Vary: Authorization` only keys the
   entry per token; the same token is a cache hit.)
2. Browsers invalidate a cached entry when an unsafe method succeeds on the
   **same URL** — but the client reads through the singular endpoint
   `/git/ref/heads/…` while the ref update PATCHes the plural
   `/git/refs/heads/…`. Different cache keys, so the extension's own
   successful ref update never evicts its cached read.
3. Profile backup is the one feature that lands batch commits back-to-back on
   one branch. Batch N+1's `readHead` typically executes well inside 60
   seconds of the ref GET that fed batch N (ten paced ascents ≈ 30–50 s, and
   read-ahead into the 30-item buffer can make the next batch ready
   immediately). It receives the cached pre-batch-N sha, builds the tree and
   commit on that old parent, and the non-forced ref update fails 422 "Update
   is not a fast forward", classified as `conflict`.
4. The bounded conflict retries (0.5 s / 2 s / 5 s, ~7.5 s total) all fall
   inside the freshness window of the same cached entry — a cache hit does not
   reset its age. Every retry re-reads the identical stale sha and fails
   identically, so the schedule exhausts deterministically and the runner
   pauses with the conflict message.

This explains the observed shape of the bug: it bites on batch 2 or later, it
is intermittent (whether the next read falls inside the 60-second window
depends on Peakbagger latency), and Resume works later because the cache entry
has expired by then — which made it look like a genuine transient race.

The worker's serialized write queue and the runner's single consumer are
working as designed; this is not a concurrency bug. The content-script side
already passes `cache: 'no-store'` for Peakbagger fetches in
`src/profile-backup.js`; the same hazard was missed on the GitHub client. The
conflict-retry rationale in
[profile-backup-pipeline.md](../profile-backup-pipeline.md) assumes a reread
observes the true head; the HTTP cache silently breaks that invariant.

## Plan

1. **Root fix — bypass the HTTP cache in the GitHub client.** Add
   `cache: 'no-store'` to the fetch init inside `request()` in
   `src/github-client.js`. One line covers every call site (ref/repo/tree/blob
   reads and all writes) for the profile batch path and both single-ascent
   paths, in Chrome and Firefox. The fix belongs in the client rather than
   `netFetch` because the client is the pure, unit-testable seam that owns the
   commit protocol's correctness.
2. **Regression test.** In `test/github-client.test.mjs`, assert in the
   scripted-fetch harness that every GitHub request carries
   `cache: 'no-store'`, so a future refactor cannot silently drop it. The
   existing "persistent ref conflict stops after the bounded retry schedule"
   test already pins the retry semantics; no change there.
3. **Docs.** Update the "Conflict and failure semantics" section of
   [profile-backup-pipeline.md](../profile-backup-pipeline.md) to record the
   browser-HTTP-cache dimension (GitHub's 60-second `max-age`; the
   singular-read/plural-write URL mismatch that prevents same-URL
   invalidation) and that the client explicitly bypasses the cache so a reread
   always observes the live head.
4. **Optional hardening (separate commit; deferred unless conflicts recur).**
   Even with `no-store`, GitHub replica lag can briefly return a stale ref
   right after our own push. The worker creates a fresh client per batch
   message, so nothing remembers the head across batches. If needed: keep the
   last successfully pushed commit sha per owner/repo/branch in worker memory
   and pass it to the client; when `readHead` returns a sha the extension
   itself already replaced, treat it as a stale read and re-read after backoff
   *before* building a doomed tree and commit (saving two wasted mutations per
   attempt). Ship steps 1–3 first; add this only if the conflict pause is ever
   seen again.

## Verification

- `npm test` for the client and runner suites.
- One real multi-batch profile run (>10 ascents, so at least two commits land
  back-to-back) against a scratch repository, confirming consecutive batches
  commit without the conflict pause.
- No manifest or bundle-composition change is involved, so
  `npm run verify:extension` is not required for this fix.

Once shipped, move this plan to [archive/](../archive/) and fold the runtime
behavior into [profile-backup-pipeline.md](../profile-backup-pipeline.md).
