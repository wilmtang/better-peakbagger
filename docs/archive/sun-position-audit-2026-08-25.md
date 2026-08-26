# Sun position code, performance, and UX audit — 2026-08-25

Status: **completed remediation ledger.** This audit found one P1 finding, four
P2 findings, and one P3 finding in the shipped Sun position feature. F1–F6 were
implemented and verified in focused commits, maintained documentation now
describes the resulting runtime behavior, and this ledger is archived.

Baseline: the audit started from a clean local `main` at `a9d838f4`, 15 commits
ahead of `origin/main`. The current implementation plan is archived in
[sun-position-calculator.md](../archive/sun-position-calculator.md), while
[sun-position.md](../sun-position.md) remains the maintained description of the
shipped behavior. This pass rechecked those contracts against current source
and deterministic probes instead of treating the earlier implementation's
verification as current evidence.

## Scope and evidence

The review traced the complete Sun path through:

- the pure astronomy wrapper and daily-event selection in
  `src/sun/sun-position.js`;
- Peak and GPX interaction state in `src/sun/sun-state.js`;
- shared DOM, accessibility, animation, and responsive styling in
  `src/sun/sun-calculator.js` and `src/sun/sun-calculator.css`;
- civil-time conversion and timezone fallback in
  `src/time/mountain-time.js`;
- the validated Peak subject and terrain-bearing integration in
  `src/maps/peak-map.js`;
- GPX selection, timestamp provenance, chart rebuilding, and iframe replacement
  in `src/gpx/gpx-analyzer.js`;
- focused unit/integration coverage under `test/sun/`, `test/time/`,
  `test/maps/peak-map.test.mjs`, and `test/gpx/gpx-analyzer.test.mjs`; and
- packaged-browser and GPU checks in `scripts/verify-extension.mjs`,
  `scripts/verify-firefox-extension.mjs`, and
  `scripts/verify-terrain-visual.mjs`.

Current-turn verification established this baseline:

- `npm test`: **1,607 passed, 0 failed** after rebuilding all 28 shipped
  bundles in `dist/`.
- `npm run lint`: passed with the eight repository-owned warnings: one
  cross-browser service-worker warning, five MapLibre warnings, one ProseMirror
  warning, and one TipTap warning.
- A direct domain probe at Aoraki / Mount Cook (`-43.595, 170.141`) for local
  noon on 2026-01-01 returned `Sun position is unavailable.` even though the
  instantaneous azimuth/elevation and ordinary rise/set events were finite.
  The selected instant was `2025-12-31T23:00:00.000Z`; the one `getTimes()`
  query returned the previous local day's cycle, so the wrapper discarded it.
- A direct domain probe at Denali (`63.0695, -151.0074`) for local noon on
  2026-06-21 also returned unavailable. Sunrise was 03:55 on June 21, while the
  corresponding sunset was 00:16 on June 22; the wrapper rejected the valid
  next-day crossing and then discarded the otherwise valid position.
- A Denver DST probe showed the selected 01:30 instant labelled `MST` on
  2026-03-08 while sunrise at 07:22 and sunset at 18:59 were both `MDT`. The UI
  currently appends `MST` to those event clocks. The inverse mismatch occurs
  before the 2026-11-01 fall-back transition.
- An isolated 1,440-minute Denver sweep took about **2.08 seconds** in the state
  layer and **2.70 seconds** through the jsdom input/render path on this audit
  host. Normal state updates averaged about 1.45 ms each. A Denver DST-gap
  conversion took about 46 ms, and resolving noon on Apia's skipped
  2011-12-30 civil date took about 580 ms. These local wall-clock figures are
  diagnostic evidence, not cross-device performance budgets.
- A controlled live-region probe rendered reading A, scheduled reading B, then
  returned to A inside the status debounce. The visible summary correctly read
  `100° E`, while the live region later announced stale `200° W` content.

No browser window was launched while creating this plan. Unit, lint, source,
and direct-module probes do not establish final Chrome/Firefox layout, native
range-control hit testing, screen-reader speech, touch behavior, live
Peakbagger markup, native browser chrome, focus, or window placement.

## Priority summary

| ID | Severity | Area | Finding |
| --- | --- | --- | --- |
| F1 | P1 | astronomy correctness | valid Sun position is suppressed when the requested solar cycle is anchored to another UTC day or a rise/set crossing lands on an adjacent civil date |
| F2 | P2 | timezone correctness | sunrise and sunset are labelled with the selected instant's zone abbreviation, which is wrong across DST transitions |
| F3 | P2 | interaction performance | every slider input repeats civil-time discovery, daily-event calculation, formatter construction, and DOM rendering synchronously |
| F4 | P2 | recovery UX | a date-specific Peak calculation failure disables and collapses the only controls that could select a working date or time |
| F5 | P2 | accessibility | the range exposes raw minute numbers, can announce stale results, and has an undersized visual/focus target |
| F6 | P3 | visual truth | below-horizon and nighttime states retain daytime visual cues, and the disclosure chevron never reflects expansion |

P1 means the feature's primary result fails at supported real-world subjects.
P2 means bounded but material correctness, responsiveness, recovery, or
accessibility debt. P3 is misleading polish or engineering debt without a
demonstrated loss of the underlying numeric result. Severity measures user
impact and urgency, not implementation effort.

---

## F1 — Resolve the requested local solar cycle without suppressing position

**Broken invariant.** A finite instantaneous azimuth/elevation at a validated
subject must remain available even if daily rise/set metadata needs an adjacent
anchor or one crossing falls outside the selected civil date. Rise/set must
describe the solar cycle whose solar noon belongs to the requested mountain
date, not whichever cycle a single UTC-based library query happens to return.

**Evidence.** `calculateSunPosition()` converts the requested local date to
local noon, passes that one instant to `getTimes()`, and accepts an event only
when `MountainTime.localDate()` exactly equals the requested date in
`src/sun/sun-position.js` (lines 23–26 and 45–53). If either crossing fails that
test, lines 54–59 accept only explicit polar flags and otherwise return `null`.
Because position and events share one nullable result, that `null` also removes
the already-finite azimuth/elevation obtained at lines 40–43.

The Aoraki and Denali probes above reproduce two distinct failures in this one
model:

1. At Aoraki during New Zealand daylight time, local noon is still on the
   previous UTC date. The single SunCalc query selected the previous local
   solar cycle, so both events failed the requested-date filter.
2. At Denali near the summer solstice, the ordinary solar cycle legitimately
   rises on June 21 and sets just after midnight on June 22. Requiring both
   crossings to have the same civil date rejects the cycle.

The existing date-line test covers one Kiritimati vector in
`test/sun/sun-position.test.mjs` (lines 56–64). More seriously, the malformed
output test at lines 66–83 intentionally treats adjacent-day events as invalid,
so the green suite pins the broken assumption rather than detecting these
real-world cases. The maintained guide repeats that assumption in
`docs/sun-position.md` (lines 64–69).

**Remediation.** Split instantaneous position from optional daily-event state.
Return the position whenever its validated inputs and package output are
finite. Resolve daily events with a bounded search over the nearby SunCalc
anchors, select the one whose **solar noon** maps to the requested local civil
date, and retain that cycle's finite rise/set crossings even when one formats
as the previous or next date. Add an explicit day relation to each event model
so presentation can say `next day` or show the date instead of silently
flattening it. Polar-day/night classification must belong to that same selected
cycle. If no trustworthy event cycle is found, show position with bounded
`Rise and set times unavailable` metadata rather than disabling the whole
calculator.

Keep the search small and deterministic. Do not scan arbitrary dates, infer
events from neighboring cycles, relax coordinate validation, or allow a package
failure to break the native map/chart lifecycle.

**Regression proof.** Add table-driven domain tests for Aoraki in NZDT, Denali
with a next-day sunset, Kiritimati across the date line, Chatham's 45-minute
zone, an ordinary Denver date, and both polar states. Pin the chosen solar
noon's local date, each crossing's local date/clock, day relation, and the rule
that finite position survives missing/malformed daily events. Replace the test
that categorically rejects adjacent-day crossings with tests that reject a
cycle whose solar noon belongs to the wrong requested date.

## F2 — Label each rise/set event in the zone active at that event

**Broken invariant.** Every displayed mountain clock must carry the timezone
abbreviation or estimate that applies to that clock's instant. A selected-time
label cannot be reused for sunrise or sunset across a political offset change.

**Evidence.** The renderer computes one `label` from `state.instant.ms` in
`src/sun/sun-calculator.js` (lines 282–303), then appends that label to the
sunrise/sunset sentence at lines 318–325. The event instants themselves are
formatted correctly, but their zone label is not derived from either event.
The Denver probes demonstrate both directions: pre-gap `MST` is attached to
post-gap `MDT` events in March, and pre-fold `MDT` is attached to post-fold
`MST` events in November. This contradicts the maintained promise in
`docs/sun-position.md` (lines 53–57).

**Remediation.** Format a clock and zone label as one value owned by its exact
instant. When sunrise and sunset share one label, concise combined copy is
fine; when labels differ, place the correct abbreviation beside each event.
Estimated longitude zones may retain one shared explicit estimate because
their offset is fixed. Compose adjacent-day wording from F1 in the same event
formatter so date relation and timezone cannot drift into separate string
paths.

**Regression proof.** Cover the 2026 Denver spring-forward and fall-back dates
with selected times on both sides of the transition. Assert the exact label for
selected time, sunrise, and sunset independently, plus an estimated-zone case.
Exercise the DOM renderer as well as the pure event model; a domain-only test
cannot catch copied presentation labels.

## F3 — Bound civil-time work and render the slider at frame rate

**Broken invariant.** Dragging the time preview must remain responsive. Work
that is invariant for a subject/date/zone must not be recomputed for every
one-minute input, and a historical civil-time discontinuity must not perform
thousands of formatter constructions on the main thread.

**Evidence.** Each range `input` immediately calls the surface callback in
`src/sun/sun-calculator.js` (lines 344–351). `sun-state.js` then runs
`civilToInstant()` and the full astronomy calculation at lines 37–59. The
astronomy wrapper recalculates the same daily rise/set cycle at
`src/sun/sun-position.js` (lines 45–59) even when only the minute changed. The
renderer constructs new long and short timezone formatters at
`src/sun/sun-calculator.js` (lines 58–68), formats the rest of the state, and
rewrites the DOM. Only decorative compass transforms are animation-frame
coalesced at lines 201–231.

The shared conversion is also allocation-heavy. `matchingInstants()` samples
offsets from minus 48 through plus 48 hours and builds new formatters in
`src/time/mountain-time.js` (lines 170–205). `civilToInstant()` may repeat that
work once per minute for as many as 1,440 adjustments at lines 207–230. The
local measurements above show ordinary cumulative drag cost and a roughly
580 ms single call for Apia's skipped civil date. The existing time tests cover
the semantic DST result in `test/time/mountain-time.test.mjs` (lines 20–31),
but no test bounds work or formatter construction.

**Remediation.** Treat this as two focused units:

1. In the pure time layer, cache formatter instances by locale/zone/options and
   resolve gaps with a bounded transition search rather than minute-by-minute
   rebuilding. Preserve the documented first-valid-minute and earlier-fold
   semantics. Keep caches bounded and module-local; do not add storage or make
   the result depend on the viewer timezone.
2. In the Sun state/view layer, cache daily events by validated
   subject/date/zone, calculate only position for minute changes, update the
   thumb/output immediately, and coalesce expensive calculation plus DOM/status
   publication to at most once per animation frame. The final input value must
   always win, and disposal must cancel pending work.

Prefer structural work counters over a brittle universal millisecond target.
Wall-clock budgets may be added in the scale suite only with enough headroom to
remain meaningful on CI.

**Regression proof.** Instrument `DateTimeFormat`, `getTimes()`,
`getPosition()`, render calls, and animation frames. A full-day drag must reuse
one daily-event result per date, publish no more than one render per frame, and
finish at the last minute supplied. Cover date changes, subject changes, map
bearing during a pending slider frame, DST gaps/folds, Apia's skipped date,
dispose-before-frame, and reduced motion. Re-run the GPX one-way tests to prove
preview coalescing never moves chart selection or route highlights.

## F4 — Keep recoverable Peak calculation failures interactive

**Broken invariant.** Failure for one date or time must not remove the date and
time controls needed to recover. Only an invalid or absent subject/zone is a
terminal Peak state.

**Evidence.** State conversion and astronomy failures collapse to the same
generic `Sun position is unavailable.` value in `src/sun/sun-state.js`
(lines 37–58). `showUnavailable()` hides the complete layout, disables the
range and date input, and disables/collapses the disclosure unless explicitly
marked expandable in `src/sun/sun-calculator.js` (lines 244–274). Peak mode
never marks a subject calculation failure expandable. The focused test
deliberately pins this terminal presentation in
`test/sun/sun-calculator.test.mjs` (lines 168–176).

Consequently, either reproduced F1 case changes a previously valid Peak panel
into a disabled `Unavailable` row. The user cannot reopen it to choose another
date, inspect the cause, or recover without reloading the page. The GPX surface
already distinguishes an openable selection prompt, so the shared component is
capable of a nonterminal empty state; the Peak state model simply does not
carry enough failure type to choose it.

**Remediation.** Model at least three presentation states: invalid/absent
subject (terminal and omitted or disabled), valid subject with a recoverable
date/time/event problem (openable with controls retained), and valid result.
Use specific bounded copy such as `Rise and set times unavailable for this
date` while keeping position when F1 permits it. Never expose caught exception
text or suggest blind retry. Preserve the GPX `Select a chart point` prompt and
missing/year-only ascent-date explanation.

**Regression proof.** Start with a valid Peak reading, force event-only failure,
full astronomy failure, timezone formatting failure, and invalid subject in
turn. Prove only the invalid subject is terminal; date/time controls remain
usable for recoverable states and a subsequent valid selection clears the
message without stale output. Repeat GPX prompt, missing-date, load/retry, and
iframe-replacement tests so the more precise state taxonomy does not regress
that recent fix.

## F5 — Give the time control truthful semantics and one current announcement

**Broken invariant.** Keyboard and assistive-technology users must receive the
mountain clock value, not an implementation minute index, and the live region
must never announce a reading that is no longer visible.

**Evidence.** The range is labelled `Mountain time` but exposes native values
0–1439 in `src/sun/sun-calculator.js` (lines 118–130). Rendering updates the
separate `<output>` clock at lines 293–302, but never sets the range's
`aria-valuetext`; a screen reader can therefore announce values such as `825`
instead of `1:45 PM MDT`.

The live-region debounce has an independent stale-state race. `announce()`
returns early when new text equals the last **published** text before it clears
a different pending timer in `src/sun/sun-calculator.js` (lines 233–241). The
controlled A→B→A probe above left A visible and published B into the status
region. Existing accessibility assertions in
`test/sun/sun-calculator.test.mjs` (lines 68–115 and 178–199) cover native
labels and bearing silence, but not range value text or this timer ordering.

Finally, the visual range box is only `0.38rem` high and its thumbs are
`1.35rem` in `src/sun/sun-calculator.css` (lines 151–177). The shared focus
outline targets that small input box at lines 61–65. Source inspection cannot
prove browser hit testing, but the declared geometry is below a comfortable
touch target and requires real-browser inspection.

**Remediation.** Set `aria-valuetext` from the same authoritative clock/zone
formatter used by the visible output, including adjusted DST values. Define
one announcement policy: cancel obsolete pending text before duplicate checks,
publish only the latest calculation, and avoid duplicating native slider speech
with a second stream of every intermediate value. Enlarge the input's hit/focus
box while preserving the restrained visual track and both browser-specific
thumb styles.

**Regression proof.** Use deterministic timers to cover A→B, A→B→A, rapid
scrubbing, duplicate results, unavailable transitions, and disposal. Assert the
range's accessible name, current clock/zone value text, min/max, and keyboard
minute behavior on ordinary, gap-adjusted, fold, and estimated-zone cases. In
hidden Chrome and Firefox, inspect focus rings, arrow-key updates, pointer
scrubbing, and target geometry at Peak and GPX widths. Automated DOM assertions
do not prove actual screen-reader speech or touch ergonomics; keep those as
explicit manual proof gaps.

## F6 — Make the visual state agree with horizon and disclosure state

**Broken invariant.** Decorative cues must reinforce, not contradict, the
numeric reading. A below-horizon Sun should not look identical to a daylight
Sun, a nighttime time marker should not sit on sunrise/sunset, and a disclosure
indicator should show whether content is open.

**Evidence.** The domain computes `isAboveHorizon` in
`src/sun/sun-position.js` (lines 61–70), but the renderer never consumes it.
Every finite result uses the same bright disc and ray in
`src/sun/sun-calculator.js` (lines 304–335) and
`src/sun/sun-calculator.css` (lines 225–243), even while text says `below
horizon`. For ordinary days, the event marker clamps every pre-sunrise instant
to 0% and every post-sunset instant to 100% in
`src/sun/sun-calculator.js` (lines 327–332), visually placing nighttime at the
sunrise or sunset endpoint instead of showing it is outside daylight. The
chevron is created at lines 44–52 and styled at
`src/sun/sun-calculator.css` (lines 83–94), but no expanded-state selector ever
rotates or otherwise changes it.

These elements are `aria-hidden`, so the issue does not corrupt accessible
text; it is visual miscommunication and unfinished presentation state. Current
tests assert only that a marker percentage exists in
`test/sun/sun-calculator.test.mjs` (lines 107–114).

**Remediation.** Derive explicit view states from `isAboveHorizon`, daylight
interval membership, polar state, and `aria-expanded`. Keep below-horizon
direction available but render its Sun marker hollow, dimmed, or otherwise
clearly below-horizon. Hide the daylight-progress marker outside the sunrise to
sunset interval, or replace the line with a truthful 24-hour model; do not clamp
nighttime onto an event. Rotate the chevron on expansion with its transition
disabled under the existing reduced-motion query.

**Regression proof.** Add DOM/state tests for above horizon, below horizon,
before sunrise, exact sunrise, daylight, exact sunset, after sunset, polar day,
polar night, expansion, and reduced motion. Capture light/dark screenshots in
both real packaged browsers at the final Peak and GPX viewports. DOM class
assertions alone do not establish visual clarity, wrapping, contrast, or touch
feel.

## Preserved boundaries and rejected scope expansion

The audit found no evidence that the Sun feature adds runtime network access,
persistence, telemetry, or a new permission. The exact `suncalc` dependency is
packaged locally, and the feature remains confined to the two MAIN-world
consumers listed in `scripts/build-config.mjs` (lines 56–63). Implementation of
this plan must preserve:

- the validated Peak subject gate in `src/maps/peak-map.js` (lines 25–72);
- trailhead-owned GPX civil time, strict per-point timestamp provenance, and the
  one-way rule that Sun preview never moves the route;
- absolute astronomy independent of map bearing, with only the decorative
  compass using `azimuth - bearing` and 2D resetting north-up;
- ephemeral page-local state with no setting, storage key, permission, CDN, or
  runtime service; and
- the documented non-goals: terrain/ridge occlusion, cast shadows, slope light,
  weather/cloud/smoke, observer-height inference, and new surfaces.

The audit also did not find a reason to move Sun code across the MAIN/isolated
world boundary, widen settings messages, modify Peakbagger's native map layers,
or couple manual Sun time back to chart position.

## Execution sequence

Each completed unit should be independently tested and committed before the
next begins. Suggested commit boundaries are descriptive, not a requirement to
force unrelated changes together:

1. **Correct the pure event model (F1).** Select daily events by local solar
   noon, preserve adjacent-date crossings, and decouple position availability.
2. **Correct event formatting (F2).** Pair each event clock with its actual zone
   and day relation.
3. **Bound shared time conversion (part of F3).** Cache formatters and replace
   minute-by-minute gap scanning without changing mountain-time semantics.
4. **Coalesce preview work (remainder of F3).** Cache date-invariant solar data,
   render at frame rate, and cancel pending work on teardown.
5. **Add recoverable result states (F4).** Keep valid-subject Peak controls
   interactive and retain all GPX selection behaviors.
6. **Repair accessible interaction (F5).** Add formatted range semantics, fix
   live-region ownership, and enlarge the target/focus geometry.
7. **Align visual state (F6).** Represent below-horizon/nighttime/expansion
   honestly and inspect the final render.
8. **Update maintained contracts and verifiers.** Revise
   `docs/sun-position.md` and, only if shared time behavior changes materially,
   `docs/mountain-local-time.md`; update packaged-browser and terrain checks at
   the same time as their product assertions.

Do not update the archived implementation plan as though it were maintained
runtime documentation. When every finding is closed or explicitly accepted,
move this audit to `docs/archive/` and remove its active index entry.

## Required verification before closure

| Check | Required proof | Important limit |
| --- | --- | --- |
| Focused unit tests | Sun position/state/DOM, mountain time, Peak map, and GPX analyzer cases above | jsdom does not prove native control rendering or browser scheduling |
| Structural/package tests | build composition, stylesheet inclusion, dependency notices, and maintained-document links | does not load the real manifest or worker lifecycle |
| `npm test` | all shipped bundles rebuild and the complete suite passes | current green tests must first stop pinning the adjacent-day defect |
| `npm run lint` | authored lint and owned `web-ext` warning policy pass | warnings are reviewed exceptions, not zero warnings |
| `npm run verify:browsers` | hidden Chrome and Firefox load real `dist/`; Peak/GPX date, slider, recovery, and accessibility postconditions pass | hidden runs do not prove native focus, screen-reader speech, or touch |
| `npm run terrain:verify` and `npm run terrain:verify:firefox` | hidden hardware renderer; absolute text remains fixed, compass follows bearing, and 2D resets north | showcase stubs do not exercise the real cross-world settings bridge |
| Visual inspection | light/dark, Peak/GPX, wide/narrow, daylight/night/below-horizon/error states in both browsers | protocol screenshots do not prove physical-device ergonomics |

Real-browser checks must follow the repository's hidden/offscreen policy,
report browser, viewport, and renderer, and verify teardown. A live Peakbagger
read is optional and must remain minimal, read-only, and rate-limited; the
deterministic real-location vectors belong in fixtures and unit tests.

## Audit closure ledger

### Fixed and verified

- **F1 — local solar-cycle correctness (`8e9c423`):** a bounded nearby-anchor
  search selects the cycle whose solar noon belongs to the requested local
  date, preserves previous/next-date crossings, and no longer suppresses a
  finite position when daily metadata is malformed. Aoraki, Denali,
  Kiritimati, Chatham, Denver, and both polar states are pinned.
- **F2 — event-owned timezone labels (`605ab84`):** sunrise and sunset format
  their exact instants, including both 2026 Denver DST transitions, estimated
  zones, and explicit adjacent-day wording.
- **F3 — bounded/coalesced preview work (`2b2a018`, `64a4c33`):** formatter
  instances are cached, civil gaps use a bounded transition search, daily
  events are cached by subject/date/zone, and slider astronomy publishes at
  most once per animation frame with the final value winning. Denver gaps and
  folds, Apia's skipped date, disposal, date/subject invalidation, GPX one-way
  behavior, and full-day structural counters are covered.
- **F4 — recoverable result states (`58bc8b8`):** valid Peak subjects retain
  date/time controls through astronomy or formatting failures, while invalid
  subjects/zones remain terminal. Existing GPX prompts, missing-date states,
  retry recovery, and iframe replacement behavior remain covered.
- **F5 — truthful accessible interaction (`2769915`):** the range exposes the
  authoritative zoned clock through `aria-valuetext`, stale live-region timers
  are cancelled before duplicate checks, and the input/focus box is 44 CSS
  pixels. Real keyboard focus and Arrow updates passed in packaged Chrome and
  Firefox.
- **F6 — honest visual state (`05ea1d0`, `24be065`):** below-horizon Sun state
  is hollow/subdued, nighttime is not clamped onto sunrise/sunset, the chevron
  follows expansion, reduced motion is preserved, and fixed-width Peak parents
  can no longer clip the calculator on narrow viewports.
- `npm test` rebuilt all 28 shipped bundles and passed **1,619/1,619** tests.
  `npm run lint` passed with the eight repository-owned warnings reviewed by
  policy. The full hidden packaged-browser gate passed in Chrome for Testing
  151 and Firefox 154. Hardware-GPU terrain verification passed in Chrome on
  the Apple M3 Pro Metal renderer and in Firefox on Apple hardware, including
  accepted bearing and 2D reset behavior.
- Light/dark and wide/narrow Peak/GPX screenshots were inspected in hidden
  Firefox at 1000×760 and a 480px narrow window. Chrome screenshots covered
  390px/wide Peak, 390px/wide/dark GPX, selection prompts, and terminal errors.
  The inspection found and closed the fixed-width Peak clipping regression in
  `24be065`.

### Intentionally not changed

- Terrain occlusion, cast shadows, slope/aspect light, weather, and atmospheric
  visibility remain explicit non-goals.
- GPX time remains trailhead-zone-owned and manual Sun time remains one-way.
- The calculator remains offline, ephemeral, permission-neutral, and limited to
  validated Peak and saved-ascent GPX surfaces.

### Changed but not fully proven

- Hidden DOM/keyboard checks and screenshots do not establish actual
  screen-reader speech or physical touch ergonomics. Polar and recoverable
  failure visuals are structurally covered but were not separately captured in
  both browser/theme combinations.
- No live Peakbagger page/provider read was needed; fixture pages use a real
  Peakbagger HTTPS hostname but do not prove future live markup. Hidden runs do
  not prove native browser chrome, visible-window focus placement, permission
  prompts, or other GPU/driver combinations.
