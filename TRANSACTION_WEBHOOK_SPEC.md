# Spec: Auto-log card transactions from iPhone bank notifications

## Goal

An iOS 27 Shortcut fires when a bank app shows a notification on the iPhone and
POSTs it to this app. A row is written **only for a charge on a card saved in
the web app**:

1. the notification names a saved card — by any of its saved **last-four endings**, or else by
   the card's **full name**;
2. **Claude Haiku 5.5** confirms it is an **already completed card purchase**, not an approval
   request, pending authorization, refund, cash in, transfer, cashback, promo or notice.

Anything else is ignored: no card is created and nothing is written. See
[Processing](#processing).

## How it fits this app

This app has no server or database. `index.html` is a static page; transactions
live in the **Transactions** tab of a Google Sheet, written by the Google Apps
Script web app in `apps-script/Code.gs`. The endpoint is that web app, so:

| Typical API | Here |
|---|---|
| `Authorization: Bearer <secret>` | Apps Script cannot read headers. The secret goes in the URL: `?token=<secret>`. |
| `WEBHOOK_SECRET` env var | A **Script Property** named `WEBHOOK_SECRET`. |
| HTTP 201 / 400 / 401 | Always HTTP 200; the outcome is the `code` and `status` fields of the JSON. |
| `cards` table | A **Cards** tab, created on first use. The web app keeps cards in the browser and copies them there so the script can search them. |
| AI provider key | A Script Property: `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY`. |

## Endpoint

```
POST https://script.google.com/macros/s/AKfycbyndwZXzpAAx2voFy8yvQEjr-0DC7NzP8RocThd76Qbyd-qx_lEneheHBYA7AeMbMQL/exec?token=<WEBHOOK_SECRET>
Content-Type: application/json
```

### Request body

All values are strings; any may be empty.

```json
{ "timestamp": "2026-10-12T15:41:00+08:00", "amount": "69.00", "last4": "",
  "note": "TikTok Shop Seller",
  "raw": "A MariBank Credit Card transaction of PHP 69.00 at TikTok Shop Seller was completed." }
```

| Field | Rules |
|---|---|
| `raw` | The whole notification (title + body). Used to find the card and sent to the AI. Required (the `text` field is also accepted). Must be 1–2000 characters; missing or longer text returns `code: 400`. A merchant `note` alone is never classified as a charge. |
| `timestamp` | ISO 8601 time of the purchase. Missing or invalid → now. |
| `amount` | Commas and `₱` tolerated. Missing or invalid → the first PHP / ₱ / P amount in `raw`. Ignored for a foreign purchase (below). |
| `last4` | Optional. Anything but exactly 4 digits counts as missing. |
| `note` | Merchant. Empty → the card's name, like rows entered by hand. |
| `app` | Optional. The notification's app, or for Apple Wallet its title (the card name). Used only to find the card; `title` is also accepted. |

### Foreign currency

If the first amount in `raw` is in another currency (`USD 12.50`, `12.50 HKD`,
`US$9.99`, `€15`, `HK$100`, `¥1,200`; `$` alone is USD), it is converted to PHP
and the **Amount column holds the PHP value**, so card totals, spend this cycle
and the recommendation stay in one currency.

The rate comes from the **FX Rates** tab, created on first use:

| Currency | Market rate (PHP per 1) | Your rate (optional) | Last used |
|---|---|---|---|
| USD | `=GOOGLEFINANCE("CURRENCY:USDPHP")` | | |

*Your rate*, when filled in (e.g. your bank's rate including its fee), wins over
the market rate. A currency not listed yet gets its own row the first time it
appears. With no usable rate the response is `code: 503, status: "no_rate"` and
nothing is saved. The Transactions row also records **Currency**, **Original
amount** and **PHP rate** (columns found by header, added on first use), and the
`logged` response adds `currency`, `original_amount`, `rate` and `converted`
(`"USD 12.50 = PHP 728.13"`).

### Row written to Transactions

Same columns the web app writes:

| Timestamp | Date | Amount | Card | Note | Last4 |
|---|---|---|---|---|---|
| when the row was written | purchase day, midnight | `454` | card name | `note`, or the card name | the card's last 4 |

**Last4 column.** Added automatically the first time it's needed: in column F
when F is empty, otherwise after the last used column, so nothing of yours is
overwritten. It's plain text, so `0469` keeps its zero. Every new row gets the
card's last 4, whether it comes from the Shortcut or the web app. It stays
blank only for a saved card that has no last 4.

**Older rows** without a last 4 are filled in automatically each time the web
app opens (when it syncs its cards): the Card cell is matched to a card on the
Cards tab by name, or by the old ids some rows carry (`EW`, `UB`, `RCBC`). Rows
for a card that no longer exists stay blank. To run it by hand, pick
`backfillLast4` in the Apps Script editor and click Run.

### Processing

Cheapest checks first, so the AI is only asked about notifications that would
otherwise be written:

1. `token` must equal `WEBHOOK_SECRET` (constant-time compare) → else `401`.
2. **Notification**: require the full `raw`/`text`. Explicit approval/verification requests,
   pending or unsuccessful transactions, refunds, added funds, transfers and promotions
   return `ignored` before any AI call. A request mentioning a price is not a charge.
3. **Card** (no cost, below). No saved card → `ignored`, **no AI call**.
4. **Amount** > 0 → else `400`, echoing what was received.
5. **Duplicate** (no cost): same card + amount + normalized merchant note + day written in the last
   2 minutes → `duplicate`, no AI call (iOS can deliver one notification twice).
6. **AI charge check**: one Claude Haiku 5.5 call. `Y` is accepted only as an exact single-letter answer from a successful API response. `N` → `ignored`. No usable
   answer (no key set, network or API error) → `code: 503`, **nothing written**.
7. Append the row.

### Card resolution

Only cards on the Cards tab that the web app still has (per its saved cards in the Settings sheet) are considered; leftover rows for old or deleted cards are skipped, so they can't tie with or beat the real card.

1. **Last 4 (first priority).** Every four digits explicitly tied to a card number
   count: the phone's `last4`, plus any `ending in 1234`, `ends with 1234`,
   `card 1234`, `card no. 1234`, `Visa 1234`, `Mastercard 1234`, `****1234`,
   `xxxx-1234` in `raw` or `app`. Each is checked against **all** endings saved for
   each card, and they must all belong to one saved card. An unsaved ending, or
   endings of two different saved cards, is refused (`ignored`): it is another card,
   so the name is never tried. Other numbers never count: `Ref 4069`,
   `PHP 4,069.00`.
2. **Full card name (only when no card digits were found).** Searched in `raw` and
   `app` (Apple Wallet puts the card name in the notification title), compared
   without case, spaces or punctuation. A card saved as `MariCard Credit` matches
   `MariCard Credit` and `Mari Card credit`, but **not** a notification that says
   only `MariCard`. The longest matching name wins (`BPI Gold` over `BPI`); two
   equally long matches are refused.
3. **Nothing matched** → `ignored`. No card is created.

### AI charge check (Claude Haiku 5.5)

| | Anthropic (`ANTHROPIC_API_KEY`) | OpenRouter (`OPENROUTER_API_KEY`) |
|---|---|---|
| Endpoint | `api.anthropic.com/v1/messages` | `openrouter.ai/api/v1/chat/completions` |
| Model | `claude-haiku-5-5` | `anthropic/claude-haiku-5.5`, or the `OPENROUTER_MODEL` property |

If both keys are set, Anthropic is used. To keep cost minimal each call sends an
explicit completed-purchase instruction plus the notification text only (≤ 2000 characters),
with thinking turned off and `max_tokens: 5`; the model answers one letter, `Y`
or `N`. Input tokens depend on notification length; usage is recorded from the provider response.

### Approval versus completed charge

`Confirm your PHP 10 purchase. Tap Yes` and `Did you make this transaction?`
are ignored even if a provider would incorrectly classify them as charges.
`Your card was charged PHP 10 at Shop. Purchase completed` is eligible for AI
verification. A successful purchase confirmation is the event to log; the earlier
request for approval is not. Duplicate checking remains merchant-specific so two
different genuine PHP 10 purchases are not discarded just because the prices match.

### AI usage and status (the web app's **AI** menu)

Every AI call is logged to an **AI Usage** tab (created on first use):
`Timestamp | Feature | API | Model | Input tokens | Output tokens | Result | HTTP | Error`.
Token counts and the model come from the provider's own response, so they are
what was actually billed and what actually answered. Today the only AI feature
is this charge check; the web page and the Google Sheet make no AI calls.

`GET …/exec?action=ai` returns what the panel shows:

| Field | Meaning |
|---|---|
| Model used | The model the provider reported on the latest call; before any call, the model the live check confirmed |
| Status | `working` (latest call succeeded) · `live` (key and model OK, no call yet) · `no_credits` · `invalid_key` · `rate_limited` · `not_configured` · `error` |
| API type | `Anthropic`, `OpenRouter`, or `Not configured` |
| Usage | Calls, input/output tokens and estimated cost for today, this month and all time; by feature; by model; the last 15 calls |

The live check uses no tokens: Anthropic `GET /v1/models/{model}`; OpenRouter
`GET /api/v1/credits` (credits left) and the model's endpoints. It is cached
for 30 seconds; the panel refreshes every 30 seconds while open.

### Responses

```json
{ "ok": true,  "code": 201, "status": "logged", "card": "EastWest", "amount": 454, "note": "SM SUPERMARKET" }
{ "ok": true,  "code": 200, "status": "ignored", "reason": "No saved card in the notification." }
{ "ok": true,  "code": 200, "status": "ignored", "reason": "Not a charge.", "card": "EastWest" }
{ "ok": true,  "code": 200, "status": "duplicate", "card": "EastWest" }
{ "ok": false, "code": 400, "error": "…", "received": { … } }
{ "ok": false, "code": 401, "error": "Unauthorized." }
{ "ok": false, "code": 503, "status": "unverified", "error": "Could not reach the AI to verify the charge; nothing was saved." }
```

### Cards tab

`ID | Bank | Last4 | Name | Source | Created`

Edit any card and press **+** next to **Last four digits** to add another physical
or virtual card ending. Each must have exactly four digits and must not already
belong to another card; remove extra endings with the minus control. All endings
share one card name, billing schedule, credit limit and statement. The first ending
remains the primary `last4` for older clients and manually entered transactions.
The app also saves a `last4s` array in its local/cloud state and sync payload.

The Cards sheet keeps one row per card and stores its endings as comma-separated
text in the existing Last4 column (for example `3002, 0123`). Existing single-ending
rows still work, including numeric sheet cells whose leading zeros were lost.
Webhook transaction rows store the actual matched ending. A name-only match and
backfilling old rows use the primary ending because the original ending is unknown.

- The web app sends its full card list on load and whenever a card is saved
  (`action=syncCards`), and removes a card's row when it is deleted
  (`action=deleteCard`). Renaming a card in the app renames it here, so later
  rows use the new name.
- A card's bank is the logo chosen for it in the app, or its name if it has none.

## Setup

1. In the Google Sheet: **Extensions → Apps Script**. Replace `Code.gs` with
   `apps-script/Code.gs` from this repo.
2. **Project Settings → Script Properties → Add script property**:
   - `WEBHOOK_SECRET` = a long random string (e.g. `openssl rand -hex 24`).
   - `ANTHROPIC_API_KEY` (from console.anthropic.com) **or** `OPENROUTER_API_KEY`
     (from openrouter.ai/keys). With OpenRouter, check its model id for Claude
     Haiku 5.5 on openrouter.ai/models; if it isn't `anthropic/claude-haiku-5.5`,
     add `OPENROUTER_MODEL` with the right id.
3. **Project Settings → Time zone**: `(GMT+08:00) Manila`. The purchase day is
   worked out in the script's time zone; in UTC, a purchase before 8 AM would
   land on the previous day.
4. **Deploy → Manage deployments → edit the existing deployment → Version: New
   version → Deploy**. Editing keeps the same URL. Execute as **Me**, access **Anyone**.
5. Open the web app once so it copies your cards to the Cards tab.

## Testing

`-L` follows Apps Script's redirect. Don't add `-X POST`: curl would re-POST the
redirect, which fails.

```bash
curl -L "https://script.google.com/macros/s/AKfycbyndwZXzpAAx2voFy8yvQEjr-0DC7NzP8RocThd76Qbyd-qx_lEneheHBYA7AeMbMQL/exec?token=$WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"timestamp":"2026-10-12T15:41:00+08:00","amount":"454.00","last4":"3002","note":"SM SUPERMARKET","raw":"EastWest: Your card ending 3002 was used for PHP 454.00 at SM SUPERMARKET."}'
```

| Case | Expect |
|---|---|
| Saved card's last 4, a purchase | `logged` |
| Saved card's last 4 only in `raw` (`Your Visa 4069 has been charged P 71.00…`) | `logged` |
| No last 4, `raw` has the full card name (`Mari Bank Credit Card`) | `logged` |
| `raw` has only `MariBank`, card saved as `MariBank Credit Card` | `ignored`, no AI call |
| Saved card, but a refund / cash in / cashback | `ignored` ("Not a charge.") |
| Same request again within 2 minutes | `duplicate`, no AI call |
| No AI key set | `code: 503`, nothing written |
| Wrong or missing token | `code: 401` |
| No amount in `amount` or `raw` | `code: 400` |

## Privacy

`?action=cards` (like the existing `?action=entries`) is readable by anyone with
the web app URL. Only the webhook requires the token.

## Applying this fix

1. Deploy the updated `index.html` through the site's normal hosting workflow.
2. Replace the bound Apps Script project's code with `apps-script/Code.gs` and
   edit the **existing** web-app deployment to use a **new version**, keeping its URL.
   Merely saving the script editor does not update an existing deployment.
3. Open the updated web app and save a card with its additional endings so the
   Cards sheet and shared state receive them. Deploy backend before using aliases.
4. In **Log Card Txn → Get Contents of URL**, use POST with a JSON request body.
   Include `raw` = the entire `Msg` notification, `amount` = `Amount`, `last4` =
   `Last4`, and `note` = `Merchant`. Keep the webhook token in the URL. The shown
   regex/merchant extraction cannot determine whether approval was requested;
   the backend must receive the original notification. The screenshots do not
   show the expanded request-body fields, so verify that `raw` is present.
5. Send an approval request and then a completed purchase using a test card/deployment:
   expect `ignored`, then `logged`, and exactly one row. Replaying the completed
   notification within two minutes should return `duplicate`.

Existing duplicate spreadsheet rows are not deleted automatically.

## Local regression checks

- `node --test tests/webhook.test.cjs` uses in-memory Apps Script services and
  mocked provider responses; it never contacts a real spreadsheet or AI API.
- Start `python3 -m http.server 8000 --bind 127.0.0.1 --directory /workspace/Transactions`,
  then run `python3 tests/test_card_endings.py -v` from the checkout. This requires
  Python Playwright and system Chromium (`CHROMIUM_PATH` can override its path).
  All external browser traffic is intercepted. It verifies adding/removing endings,
  validation, cloud-state restoration, local persistence, outgoing sync payloads,
  built-in/custom cards and desktop/mobile layout.
