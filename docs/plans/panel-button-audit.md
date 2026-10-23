# Panel button audit — October 23, 2026

## Fixed and verified

- Garmin forced 44px action heights while existing settings actions were 33px.
  The browser regression reproduced those exact sizes before the fix.
- Settings, activity inbox, popup, draft/climber managers and Photo Topos now
  use `.panel-button` from `src/theme/panel.css`. Standard actions share a 34px
  desktop minimum height, 13px type, padding, radius, focus and disabled states.
  Coarse-pointer targets retain a 44px minimum; wrapped text can grow the control.
- `primary`, `secondary`, `danger`, `quiet` and `link` express emphasis. Page CSS
  retains placement, not separate action sizing. Destructive confirmation styles
  and inline Undo styles no longer duplicate the component.
- Removed fixed Garmin button widths. Alternate labels reserve their actual
  text width. Reconnect becomes secondary when already connected, leaving Enable
  Garmin drafts as the setup action.
- Visual review caught a flex row breaking “Add” into separate letters. Preserve
  word widths and check its single-line height in both real-browser verifiers.
- Tests require every ordinary action, including dynamically rendered settings
  actions, to use the shared class. Special controls have an explicit allowlist.
- The popup's persistent inbox entry pushed long capture results below its
  600px limit. Keep the complete peak list scrollable within 160px so capture
  controls fit. The existing popup layout check failed before this correction
  (results bottom at 625px), then passed for ready, opening and opened states.

Validation: 3,374 tests passed; the final focused popup/component run passed
54 tests and the final component/contrast run passed 15. ESLint and packaging
lint passed with eight existing owned warnings. Hidden real-extension checks
passed in Chrome 156 and Firefox 158, including the Add-height regression.
Twelve Garmin fixture cases passed in Chrome 156/Firefox 157 at 1180×1000 and
390×1000, both themes, plus inbox CSS zoom at 200%. Geometry/focus checks cover
Show/Hide, reconnect failure/retry/success, saving preferences, enable
failure/retry/success and refreshed inbox labels. Popup checks passed 15 states
across seven theme/scale variants per browser at 390×600; actual hidden Chrome
popup sizing also passed over tabs at 100%/200% zoom. Eight popup transition
cases passed at 390/1280×900 with a 1px geometry tolerance. Settings, inbox,
popup, Photo Topos and climber screenshots were visually inspected. These are
DOM/CSS checks, not WebGL renderer verification.

## Intentionally not changed

- Tabs, icon buttons, drag handles, repository/code pickers and canvas controls
  retain their task-specific layouts. Native Peakbagger page controls are outside
  this extension-panel refactor.
- Popup actions retain the full column where appropriate. Inline actions retain
  their link treatment. Successful Garmin enabling deliberately removes its
  completed setup action; pending/error/retry states keep it anchored.

## Changed but not fully proven

- Hidden browser checks do not establish OS focus, visible browser chrome,
  physical touch usability or screen-reader announcements.
- Garmin permission and network replies are stubbed for repeatable UI states.
  No live connection, import, deletion or Peakbagger Save is exercised here.
