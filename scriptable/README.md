# Recommended Card on your iPhone

This is a real Scriptable Home Screen widget for the existing Smart Card Advisor site. It shows only your recommended card’s name, existing bank logo, and primary ending as `•••• 1234`. Small, medium, and large layouts support the system’s light and dark appearances. Tapping anywhere opens your existing site’s recommendation section (`#overview`). No Mac, Xcode, developer membership, custom App Store publication, subscription, or new hosting service is required.

## What is connected

Previously, `index.html` alone calculated recommendations; the winner was not stored on the backend. Both the site and Apps Script now execute the same engine, extracted into [`recommendation.js`](../recommendation.js). [`apps-script/Recommendation.gs`](../apps-script/Recommendation.gs) is a generated copy of that exact source, not a separately maintained algorithm. Tests reject a stale copy.

The widget asks the existing Apps Script deployment for the recommendation using the **saved shared Cards settings and Salary schedule in the Settings sheet**. It shows the same card as the website: **today’s AI pick** for Asia/Manila. The shared engine works out every card’s statement and due dates (holidays included), keeps only cards with a payday before the due date (paid on the 24th → due the 25th onwards) that aren’t about to close their statement, and of those offers only the cards with the lowest spend this billing cycle (₱0 first; within ₱500 counts as a tie), so every card gets used in turn. The AI (the same Anthropic/OpenRouter key the charge check uses) chooses one of those, balancing time to pay, how much of the credit limit is used, and how soon the statement closes. The pick is refreshed just after 12:00 AM Philippine time and whenever cards, the salary schedule or a card’s use this cycle change. Without an AI key, or if the AI call fails, the engine’s own pick (lowest spend this cycle, then longest time to pay) is used. Only the date, card name, last 4 and amount of recent transactions are read, to total each card’s spend this cycle; notes are not.

The widget represents **today’s recommendation**, which is the site’s default recommendation. Choosing a different transaction date in the website is a temporary what-if calculation; it does not change today for other devices. Local edits made offline can reach the widget only after the site successfully syncs them to the sheet. The widget does not mirror a manual card radio selection, because that is not a system recommendation.

For a card with multiple saved endings, the widget shows the primary ending (the first valid saved ending), identifying the recommended card account. It does not rotate between physical/virtual endings. If that card has no valid saved ending, digits are omitted; no number is invented. Choose a logo and save an ending in the existing card editor if either is missing.

## Deploy from your iPhone

These are one-time updates to your **existing** site and Google Apps Script deployment. You need access to the repository, hosting settings, Google Sheet and bound script project. This implementation does not include credentials for those accounts and has not published either deployment for you.

1. Publish this repository’s updated `index.html`, new `recommendation.js`, and the `widget-logos/` directory alongside the existing root logo assets using your normal hosting process. If your existing GitHub Pages site publishes `main`, merge these changes to that published branch. Keep the same website URL. Do not deploy only `index.html`: it now loads `recommendation.js` before its own script.
2. In Safari, open your existing Google Sheet’s bound Apps Script project. If the mobile view hides the editor or menus, use Safari’s **Request Desktop Website**. Alternatively open the project at **script.google.com** while signed into the Sheet’s owner account.
3. Replace the existing `Code.gs` contents with [`apps-script/Code.gs`](../apps-script/Code.gs).
4. Add a Script file named **Recommendation** (the editor appends `.gs`). Paste the **entire** [`apps-script/Recommendation.gs`](../apps-script/Recommendation.gs) into it. Do not paste `recommendation.js` into `Code.gs` or omit the new file. Keep all existing Script Properties, including your webhook and AI properties.
5. Install the free **Scriptable** app from the App Store. In Scriptable, tap **+**, paste [`create-read-token.js`](create-read-token.js), and run it. It generates a private random 64-character token and copies it to your clipboard. Save that value in your password manager. Do not put the value in GitHub, a URL, widget parameters, or chat.
6. In Apps Script, open **Project Settings → Script Properties → Add script property**. Set the name to **WIDGET_READ_TOKEN**, paste the generated value, and save. This is a **different** secret from `WEBHOOK_SECRET` and your AI provider keys. It grants only access to the new minimal recommendation endpoint.
7. Set the project’s time zone to **Asia/Manila**, as required by the existing transaction app. The widget explicitly uses Manila even if the device is in a different time zone.
8. Choose **Deploy → Manage deployments → edit your existing Web app deployment → Version: New version → Deploy**. Keep its existing URL and access configuration; the existing app uses **Execute as: Me**, **Who has access: Anyone**, with route-level authentication on the new widget action. Merely saving the editor does not update deployed code. Do not create a different deployment unless you also update the website’s `WEB_APP_URL` deliberately.
9. Copy your existing Web app deployment URL ending in **`/exec`**, with **no query parameters**. You will enter it in Scriptable; the token will be sent only in a POST body. Do not use `/dev`, the script editor URL, or the spreadsheet URL.
10. Open your deployed website, refresh once, and let its existing cloud sync finish. Save your card/salary settings if they were previously local only. This initializes the shared Settings sheet; there is no separate widget snapshot to upload. Confirm the recommendation for today on the website.

The editor is usable through Safari’s desktop view; no iOS app compilation or local development machine is part of these steps. Google’s editor UI may require zooming on a small phone screen.

## Install the widget using only your iPhone

1. Open [`recommended-card.js`](recommended-card.js) in this repository (or its Raw view) in Safari and copy the entire source.
2. Open **Scriptable → +**, paste the code, and name the script **Recommended Card**. Keep that name afterward: it scopes this script’s Keychain settings and cache.
3. Tap **Run** inside Scriptable. In **Connect Card Advisor**, enter:
   - **Existing website HTTPS URL:** your actual Smart Card Advisor URL, for example your current GitHub Pages site. Include its repository path if it has one. Both a trailing slash and an `index.html` URL work. This is where logos are loaded and where tapping the widget goes.
   - **Google Apps Script /exec URL:** the existing deployment URL from step 9, without `?token=` or other query parameters.
   - **WIDGET_READ_TOKEN:** the same private value saved in Script Properties. The secure prompt stores it in Scriptable’s **Keychain**, separate from public source code.
4. Tap **Save**, then choose **Small**, **Medium**, or **Large** to preview that layout using the real endpoint. The script can ask for permission to contact your Google deployment and existing site; allow those requests. Run again to preview each size. Compare the card name and primary ending with today’s website recommendation.
5. Return to your iPhone Home Screen. Touch and hold an empty area, choose **Edit → Add Widget** (or **+**, depending on iOS), search for **Scriptable**, choose the size you want, and tap **Add Widget**.
6. Touch and hold the new widget → **Edit Widget → Script → Recommended Card**. Leave **Parameter** empty. The script supplies its website destination through `widget.url`; no URL or token belongs in the Parameter field. Dismiss editing.
7. Tap the widget once to confirm it opens the Smart Card Advisor recommendation section. You can add all three sizes using the same script and Keychain configuration.

The widget deliberately contains no setup buttons, labels, refresh indicators, or extra financial details. Run the script inside Scriptable whenever you need the setup/preview menu. **Reconnect** changes settings and purges cached data. **Clear cache** removes local card/logo data. **Disconnect** also removes this script’s Keychain configuration. After using Disconnect, remove the Home Screen widget if you no longer want its previous system-rendered image visible.

## Refresh, offline use and empty states

- Every execution fetches the current backend result. The backend keeps one AI pick per Philippine day (in the `DAILY_RECOMMENDATION` Script Property) and replaces it after midnight or as soon as cards or the salary schedule change, so it never shows yesterday’s card. To have it refreshed right at midnight, run `installDailyRecommendationTrigger` once from the Apps Script editor (Run ▸ select the function); the first request of a new day refreshes it anyway. Logo images are cached locally to avoid repeatedly downloading unchanged branding.
- The script requests another execution **no earlier than 30 minutes later** using `refreshAfterDate`. iOS and Scriptable choose the actual schedule. Low Power Mode, usage patterns, connectivity and system budgets can delay it. This is not live push, and neither a website edit nor a manual Scriptable preview forces an immediate Home Screen redraw.
- A successful recommendation is saved in Scriptable’s **local Library directory**, outside public source and iCloud Documents. A temporary request failure reuses that most recent result and cached logo. Offline data can be stale until the next successful permitted refresh. If the new logo has never been downloaded and is unavailable, the widget shows the real name/digits without a substitute logo.
- A successful `card: null` response replaces the old recommendation and shows **No Recommended Card**. This includes missing initial cloud settings, no saved cards, or no card meeting the rules. A detected invalid/revoked token clears the private local cache. With neither a current result nor a usable cache, the same simple empty state appears.
- Card names wrap and scale within the layout. Use a concise identifying card name in the existing editor for very long custom names. The actual native appearance, system tint modes, Dynamic Type and refresh timing should be checked in Scriptable on your iPhone; this repository’s automated tests use Scriptable API doubles, not an iOS simulator.

## Security and API contract

Request: HTTPS **POST** to the existing Apps Script `/exec` URL, with `Content-Type: application/x-www-form-urlencoded` and fields `action=widget` and `widgetToken=<your separate read token>`. Apps Script does not expose incoming Authorization headers; using the POST body avoids leaking a bearer token in query strings. Do not log requests or put this body into public examples containing real credentials.

A successful response contains exactly:

```json
{"ok":true,"card":{"name":"<actual saved card name>","logo":"<existing relative logo asset>","last4":"<four saved digits>"}}
```

Or `{"ok":true,"card":null}`. There are no card IDs, balances, limits, transactions, full card numbers, dates, database credentials or server secrets in this projection. Unknown last four digits or unavailable logo references are empty strings. Library SVG references are rendered using committed PNG versions of those exact assets in `widget-logos/`, because Scriptable’s native image decoder does not load SVG. Existing PNG logos are loaded directly from the same website.

Errors are `{"ok":false,"code":401,"error":"Unauthorized."}` or a generic `code:503` response. Apps Script normally returns HTTP 200 even for these application errors; clients must check JSON `ok` and `code`. Authentication is checked before reading state. The token is scoped to reading this response and is not accepted as the webhook secret. GET `action=widget` is not enabled. No new database permissions or security rules are weakened.

**Existing backend limitation:** the app already exposes other read routes and unauthenticated `saveState`/card sync writes, and publishes transaction CSV data. The widget adds authentication to its own endpoint; it does not retroactively secure these existing routes. Its recommendation is as trustworthy as the existing shared settings. Securing the entire app requires a separate authenticated website write flow; do not assume a widget token locks down the old endpoints.

To rotate access, replace `WIDGET_READ_TOKEN` in Script Properties, then use **Reconnect** in Scriptable with the new token. No code edit or redeploy is needed for a Script Property change. An already-rendered iOS widget cannot be remotely erased immediately; clear/disconnect on the phone and remove it if necessary.

## Troubleshooting from your phone

- **No Recommended Card after setup:** verify today’s website has an eligible card, wait for its settings sync, check the same token is present in both places, and ensure you deployed a **new version** containing **both `.gs` files**. With no cache, authorization errors and backend failures also show the minimal empty state.
- **Old card:** reconnect to the internet, run the script inside Scriptable to verify the latest endpoint response, and allow iOS to schedule the Home Screen refresh. Unsynced browser edits are not available to the backend. An explicit no-recommendation response clears the previous result.
- **Missing logo:** publish `widget-logos/` and the existing root PNG assets under the website URL entered during setup. Check the repository path in that URL. Re-run the preview online; failed image downloads are retried next time.
- **Preview works but tap opens Scriptable:** confirm the widget has the correct script selected and allow it to execute once after setup. The script supplies the existing site’s `#overview` URL via `widget.url`. If your version offers a manual Open URL interaction override, use that same existing website URL ending in `#overview`.
- **Different card on the website:** use today’s transaction date, reload the site’s shared settings, and check its cloud save succeeded. A different historical transaction date or an offline device is not the current shared recommendation.

## Developer validation and maintenance

From the repository root:

```sh
python3 scripts/sync-widget-assets.py --check
node --test tests/*.test.cjs
python3 -m http.server 8000 --bind 127.0.0.1 --directory .
# In another terminal:
python3 tests/test_card_endings.py -v
```

The Node suites include the original webhook tests, endpoint authentication/projection, changes to saved state, Manila rollover, and Scriptable execution with API doubles for all three sizes, offline recovery, null results, revoked tokens and invalid full numbers. A frozen baseline generated from the original app checks recommendation, statement and due dates across **1,107 cases**, including leap days and 2026 holidays. Run the recommendation suite with `TZ=America/New_York` as well to verify timezone independence.

When recommendation rules or the logo library change, edit only `recommendation.js`, run `python3 scripts/sync-widget-assets.py`, and deploy both the website source and the generated Apps Script file together. Do not edit `Recommendation.gs` by hand. When the existing SVGs change, regenerate their rasterizations with `python3 scripts/render-widget-logos.py` (requires Python Playwright and Chromium); no new logos are invented.

Cloud tests do not deploy Apps Script, access your live Sheet, or execute the native Scriptable app. Finish deployment and the phone preview/tap checks above to validate those boundaries.
