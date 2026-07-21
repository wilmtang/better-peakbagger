# Better Peakbagger developer documentation

Start with the [architecture and design guide](architecture.md). It contains the
runtime diagram, trust boundaries, module ownership, and deep dives for every
shipped subsystem.

## Maintained guides

- [Architecture and design](architecture.md) — current runtime topology,
  invariants, feature ownership, and deep dives.
- [Development](development.md) — build, test, browser, dependency, and package
  workflow.
- [Browser store releases](releasing.md) — release checklist and the manual
  checks that automation cannot establish.
- [Privacy and data handling](../PRIVACY.md) — canonical public disclosure and
  field-level data boundaries.

## Focused design notes

These are living documents. Update them with the implementation when their
subsystem changes.

- [Trip-report editor: markup, Markdown, and safety](trip-report-editor.md)
- [GitHub backup: ascent entry points and favorite-list transfer](github-ascent-backup.md)
- [Peakbagger native map types](peakbagger-map-types.md)
- [3D map architecture and runtime contract](3d-map.md)
- [Peakbagger peak dots on 3D terrain](3d-peak-markers.md)
- [Chart times in the climb's local timezone](mountain-local-time.md)
- [Dark-mode startup without a light-page flash](dark-mode-flash.md)

## Document lifecycle

- [Active plans](plans/) are for approved work that has not shipped. A plan is
  not a source of truth for runtime behavior.
- [Archived notes](archive/) preserve completed plans, audits, experiments, and
  point-in-time research. They may contain stale file names, commands, or
  assumptions.
- Shipped behavior must be reflected in the architecture guide and, where the
  subject warrants it, one focused design note. Do not leave the only accurate
  description inside a completed plan.
