# Garmin activity inbox

Connect Garmin to prepare Peakbagger ascent drafts automatically. You review
the detected peaks and click Save in Peakbagger yourself.

## Set up

1. Open **Settings → Capture & reports → Garmin connection**.
2. Use **Get a Garmin API key** to open
   [Garmin’s key page](https://connect.garmin.com/app/settings/personalApiToken).
   Paste the key, choose **Connect Garmin**, and allow access when your browser asks.
3. Open Peakbagger and sign in to your climber account, then choose
   **Enable Garmin drafts**. Keep a signed-in Peakbagger tab available for peak matching.
4. Open **Activity inbox** from the extension popup to review activities.

## Choose when and how far back to check

| Setting | What it does |
| --- | --- |
| Check every | Runs while your browser is open. Default: four hours. Choose Manual only or a custom interval of 1–168 hours. |
| Recent check range | How far back regular checks and Check now look by activity date. Default: 30 days; custom: 1–365 days. |
| Full history range | The earliest activity date to include. Default: connection date through today. Choose an earlier date or all history. Checked about weekly, or with Check full history. |

Recent checks stay within your full history range. After time offline they can
look farther back to catch up. Large histories continue in small batches; Manual
only disables automatic continuation, so use Check now again to continue.

Garmin returns activities by **activity date**. Upload-date sorting was not
honored in testing. The full-history check finds older activities uploaded late.
Activity IDs and saved/dismissed history prevent repeat imports on this device.
Ascents entered manually or imported independently elsewhere are not guaranteed
to be detected as duplicates.

**Activities:** the default **Mountain activities** group includes hiking,
walking, trail running, rock climbing, mountaineering and backcountry skiing.
Garmin's backcountry type also includes snowboarding. **All activities** admits
other types, including resort skiing and indoor workouts. Draft preparation
needs a usable GPS track. Existing default-group preferences gain the added
types automatically; choose **Check full history** to find older activities now.

## When Peakbagger needs attention

Garmin discovery continues on your chosen schedule. New activities wait locally
if Peakbagger is closed, signed out, rate limited or asking for a human check.
The inbox shows how many activities are waiting for peak checks. Open a
Peakbagger tab and complete any check or sign-in: returning to a loaded
Peakbagger page resumes the queue automatically, including in Manual only mode.
This prepares activities already discovered; it does not scan Garmin history.
Rate-limit cooldowns still apply. No tabs open automatically and ready drafts
are not prepared again.

## Review and recover

- Strong matches start selected. Review Probable matches before selecting them.
- **Open selected drafts** opens Peakbagger forms. Verify each ascent and Save.
- **Refresh from Garmin** keeps the existing snapshot while preparing new results.
  Choose **Review updated matches** to accept refreshed suggestions.
- Drafts do not expire in the inbox. The separate form handoff lasts 30 minutes.
  If its outcome is uncertain, review the existing forms and saved ascents before
  marking the activity done; the extension does not automatically replay it.
- **Dismiss activity** offers Undo for one minute. **Mark activity done** removes
  it from the inbox and prevents another import.
- If Garmin rejects a key, imports pause and drafts remain available. Use
  **Update key**. The error cannot reliably distinguish expiry from revocation.
- Unsupported or damaged FIT recordings need Garmin’s GPX export. Legacy FIT
  protocol 0 and multisport recordings are currently unsupported.

Keys, reduced routes and history stay on this device. **Disconnect** keeps drafts;
**Delete local Garmin data** removes them and their duplicate-prevention history.
The key is included in a downloaded settings file only when **Include saved
credentials** is checked. Importing it on a new device still requires enabling drafts.

See the [audit ledger](plans/garmin-inbox-audit.md) for verification and release
gaps, and the [investigation](plans/garmin-personal-api-draft-inbox.md) for API evidence.
