# Sanitized provider contract fixtures

These are small, synthetic compatibility contracts for the provider page
adapter. They are not page dumps and contain no real profile IDs, names,
cookies, tokens, coordinates, private GPX, or response headers. Relative links
are resolved only inside isolated test pages whose network is blocked.

The corpus deliberately covers owned, non-owned, loading, signed-out,
localized, challenge, navigation, Garmin session-mode, and representative
response-body shapes. Fixture success does not prove that current live Garmin
or Strava markup, export endpoints, or anti-bot behavior still match.

Last minimal live read-only verification:

- Chrome: not performed as of 2026-09-03.
- Firefox: not performed as of 2026-09-03.

