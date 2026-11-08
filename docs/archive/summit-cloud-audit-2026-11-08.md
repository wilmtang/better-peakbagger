# Summit Cloud Cover audit (November 8, 2026)

Audit of the experimental card and its cloud decision, reviewed by a second agent
before and after implementation. Method and limits now live in
[weather.md](../weather.md#summit-cloud-cover). Evidence:
[saved probe](../plans/evidence/summit-cloud-humidity-basis.json). Live checks covered
one day on about 17 peaks, so they show field structure, not forecast skill.

## Findings

| Finding | Live evidence | Resolution |
| --- | --- | --- |
| Water-referenced humidity read saturated cold air as dry, so clear was possible and inside effectively unreachable | ICON/GEM max humidity tracks ice saturation; captured Rainier HRRR at −10 °C read partial | `humidityBasis`, mixed-phase saturation, cloud re-derived below 0 °C |
| Any model difference read as uncertain | Mount Washington 19/24 hours uncertain, mostly partial + inside | Two models report what both support |
| One unresolved model made every hour uncertain | Mount Stuart GFS + IFS 24/24 | Survivor's reading, named and low confidence |
| HRRR levels left Colorado's high peaks unbracketed | Longs 24/24 and Elbert 12/24 unavailable | HRRR gains 675 and 625 hPa |
| Requests for levels never served | ICON 750/650, JMA 250 | Per-model lists |
| No lower air to lift was treated as missing data | Elbert HRRR 3/24 uncertain | Applicability rule and moistest air in the lower band |
| Automatic tomorrow lost its late hours | 8 of 24 hours outside both high-resolution feeds | First high-resolution feed + GFS, same request count |
| Source line under-reserved, moved the card 17 px at 390 px | Hidden browser geometry check | Reserves every Automatic pairing and the confidence label |
| `nativeCloud` and `sparse` flags unused | No readers | Removed |

## Closure ledger

**Fixed and verified**

- Every finding above, by regression tests. The cold-air and no-rise cases were shown
  failing on the old implementation.
- Rendered Automatic, sole-survivor, merged and cold-air states had no layout shift in
  hidden Chrome for Testing 156 and Firefox 159 at 1440, 390 and 320 px, with provider
  and settings responses stubbed. That check extended the committed verifier
  temporarily; the committed one still covers only its original states.

**Intentionally not changed**

- Thresholds, lift physics and sampling geometry: no calibration data justifies a change.
- A missing native level inside a bracket: treating it as uncertain would make ICON's
  permanent gaps uncertain forever. The 2,200 m cap and low-confidence gap rule apply.
- UKMO stays unadjusted: its cold-air humidity is ambiguous. Exposure is manual-only.
- Two-model Automatic stays capped at two requests rather than adding a third model.

**Changed but not fully proven**

- Forecast skill: nothing here is validated against summit observations.
- False “inside” in clear supersaturated air below −20 °C on HRRR, HRDPS and ICON. No
  flagged model had a summit colder than −13 °C in the saved profiles.
- The humidity classification rests on one day. Level capability was checked at one
  point per model.
- Re-derived cloud matches the provider on captured HRRR values and at GEM bucket
  maxima only.
- HRRR 675/625 hPa on real Colorado profiles: saved profiles predate the change, so
  Longs and Elbert were not re-run live.
