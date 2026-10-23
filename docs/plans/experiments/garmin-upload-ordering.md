# Garmin upload ordering: supporting evidence

Checked October 23, 2026. The [implementation plan](../garmin-personal-api-draft-inbox.md)
keeps a 30-day activity-date scan every four hours and a weekly scan of the
user's full chosen history. Upload-time sorting was not established.

## Public contract

[Garmin's OpenAPI reference](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)
defines `startLocal` as the default sort field and descending as the default
direction. `startDate` and `endDate` filter activity-local start dates. The list
uses `start`/`limit` offset pagination; its 32 query parameters include no
uploaded-after filter, change cursor or complete supported-sort enum.

Activity details expose `metadataDTO.uploadedDate` and `lastUpdateDate`; the
sampled list summaries did not. These fields are documented as UTC despite
omitting `Z` or an offset. Parse them explicitly as UTC. `activityId` is
documented only as a unique identifier, with no upload-order guarantee.

## Live tests

All probes were authorized, bounded and read-only apart from token exchange.
Credentials and private responses stayed in process memory. Only counts,
status codes and ordering checks were printed; no activities were mutated.

The first sort probe used `limit=3`, both directions: `startLocal` returned
three items; `uploadedDate`, `uploadDate` and an invalid field returned none.

The expanded probe used `start=0&limit=5`, both directions, without date filters:

| Sort field | Result in each direction |
| --- | --- |
| `startLocal` | Five items, correctly ordered by activity date. |
| `distance` | Five items, correctly ordered by distance; different IDs from the date control. |
| `uploadedDate`, `uploadDate`, `uploadTime`, `uploadTimestamp`, `dateUploaded`, `metadataDTO.uploadedDate`, `createdDate`, `createdTimestamp` | HTTP 200 with an empty list for every field. |
| Deliberately invalid field | HTTP 200 with an empty list. |
| `activityId` | Five items; IDs and detail upload times followed the requested direction, but the ID sequence exactly matched the date control. Inconclusive. |
| `id` | Five items; neither IDs nor detail upload times followed the requested direction. |

The final date control matched the initial one. This probe made 48 requests:
one token exchange, 27 list reads and 20 detail reads. It downloaded no recordings.

A follow-up compared `startLocal` and `activityId` at `limit=100`, both directions.
All four lists returned 100 items with identical ID sequences for each direction,
ordered by both date and ID. No distinguishing late-upload case appeared.
This took one token exchange and four list reads, with no further detail reads.
It does **not** independently prove ID sorting or an upload-order guarantee.

A separate earlier test retrieved the oldest activity and its original file:
it was more than five years old. That establishes historical access for this
account, not a universal Garmin retention guarantee.

## Limits of the conclusion

The eight upload/creation field spellings were unusable on this account. Other
undocumented aliases or future API changes remain possible. HTTP 200—or even a
nonempty list—is not proof that a requested sort was honored. A convincing test
needs records whose activity-date and upload-date orders differ, including
timestamp ties and page boundaries. A filter also needs a cutoff test that
demonstrably excludes older uploads. No controlled late upload was created.

## Requirements for a future upload checkpoint

This is not the selected discovery algorithm. If upload sorting/filtering
becomes reliable:

- Advance a checkpoint only after all discovered IDs and pending work are
  durably stored. The newest successful import can leave older failures behind.
- A filter can restrict the server response; sorting alone only permits paging
  newest-first until an older boundary is reached. Detail-only timestamps may
  require extra reads to identify that boundary.
- Include tied timestamps and an overlap; deduplicate by account/activity ID.
  An incomplete scan keeps the previous committed checkpoint.
- Keep periodic full checks until pagination and indexing-delay guarantees are
  established. Upload time does not identify later edits or deletions.
- Preserve the user's selected activity-date scope and account binding.

Finding uploads by comparing a full ID inventory remains possible, but still
requires broad history scans; it does not provide the proposed timestamp shortcut.
