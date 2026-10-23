# Garmin key-expiry verification

Checked October 23, 2026. **Key rejection is detectable; expiry specifically
is not established by the evidence below.** Use the generic Update key message
until an expiry-specific response or authoritative key-expiry field is verified.

## Live authentication results

Five bounded POSTs to Garmin's documented
`/personalapitoken-service/personal-api/personal-api-key/token` endpoint used
`Accept: */*`, with redirects refused:

| Input | Actual response |
| --- | --- |
| User-authorized key | **200**, `text/plain` JWT; `exp - iat = 86400` seconds. Its only expiry-related claim was `exp`; no personal-key expiry date was returned. |
| No Authorization header | **400**, JSON `{"error":"Authentication missing","status":400}`. |
| Fictional malformed key | **401**, empty body, `WWW-Authenticate: Bearer`, no Content-Type. |
| One character changed in the authorized key's secret segment | **401**, the same empty body and headers. The saved real key was not changed. |
| Authorized key, additional metadata check | **200**; no expiry header, and no nested key-expiry claim. The only expiry-related token path was `exp`. |

These are successful-key and rejected-key tests. **Neither failed key was a
genuinely expired key.** They do not prove that expiry and revocation return the
same response. The available real key was valid, and no key was revoked or
replaced. No activities were read. Credentials, returned tokens and their claim
values stayed in process memory; only status and non-identifying schema
metadata were recorded.

## Official contract and reference client

- The [FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)
  distinguishes key lifetime from the access token's maximum 24-hour lifetime.
  It exposes key status/expiry through Garmin Connect's website, but does not
  document an API expiry field or expired-key error code.
- The [published OpenAPI reference](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)
  contained 26 paths. None was a token/key-management endpoint. Its generic
  data-endpoint authentication errors do not establish token-exchange behavior.
  The specification was read from the page's public component bundle
  `component---src-pages-gc-developer-program-personal-swagger-docs-js-178270c98d5ec74e74ef.js`.
- Garmin's own [authenticator](https://github.com/garmin/connect-personal-api-python/blob/ac111a0ff8e37dfbc24c616fcc27691520c7278b/src/garmin_personal_api/auth.py)
  reads JWT `exp` for token caching and forwards unsuccessful exchanges as
  [generic HTTP errors](https://github.com/garmin/connect-personal-api-python/blob/ac111a0ff8e37dfbc24c616fcc27691520c7278b/src/garmin_personal_api/errors.py).
  It has no key-expiry classifier. Its auth tests use stub responses; they are
  not evidence of a live expired-key response.

## Implementation decision

On an activity **401**, exchange the saved key for a new token once, then retry
the activity request once. A **401 from that token exchange** pauses imports
and shows **“Garmin needs a new API key. Imports paused; your drafts are safe.”**
with **Update key**. If the exchange succeeds but the activity still fails,
report an access failure; do not infer that the key expired.

Keep missing-header/request errors, permission failures, network failures and
rate limits separate. Do not infer key expiry from HTTP 401 alone, JWT `exp`,
the key's undocumented string segments, or one year since connection.

The expiry-specific mock remains an illustrative future state. Enabling it
requires a documented expiry signal or a bounded test with a genuinely expired
key that returns an unambiguous expiry reason. No such key was available here.
