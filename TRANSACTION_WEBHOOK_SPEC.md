# Spec: Auto-log card transactions from iPhone bank notifications

## Goal

An iOS 27 Shortcut fires when a bank app shows a notification on the iPhone and
POSTs it to this app. A row is written **only for a charge on a card saved in
the web app**:

1. the notification names a saved card — by its **last 4 digits**, or else by
   the card's **full name**;
2. **Claude Haiku 5.5** confirms it is a charge (money out), not a refund, cash
   in, cashback, promo or notice.

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
| `raw` | The whole notification (title + body). Used to find the card and sent to the AI. Missing → `note` is used instead. Capped at 500 characters. |
| `timestamp` | ISO 8601 time of the purchase. Missing or invalid → now. |
| `amount` | Commas and `₱` tolerated. Missing or invalid → the first PHP / ₱ / P amount in `raw`. |
| `last4` | Optional. Anything but exactly 4 digits counts as missing. |
| `note` | Merchant. Empty → the card's name, like rows entered by hand. |

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
2. **Card** (no cost, below). No saved card → `ignored`, **no AI call**.
3. **Amount** > 0 → else `400`, echoing what was received.
4. **Duplicate** (no cost): same card + amount + note + day written in the last
   2 minutes → `duplicate`, no AI call (iOS can deliver one notification twice).
5. **AI charge check**: one Claude Haiku 5.5 call. `N` → `ignored`. No usable
   answer (no key set, network or API error) → `code: 503`, **nothing written**.
6. Append the row.

### Card resolution

Only cards on the Cards tab (the cards saved in the web app) are considered.

1. **Last 4.** The phone's `last4`, or a saved card's last 4 standing on its own
   in `raw` (`Visa 4069`, `ending in 4069`). Digits inside a number or an amount
   don't count: `PHP 4,069.00` does not match a card ending 4069.
2. **Full card name.** Compared without case, spaces or punctuation. A card saved
   as `MariBank Credit Card` matches `MariBank Credit Card` and
   `Mari Bank credit card`, but **not** a notification that says only `MariBank`.
   The longest matching name wins (`BPI Gold` over `BPI`). A name match is refused
   when the phone sent a last 4 that differs from the card's: that is another
   card from the same bank.
3. **Nothing matched** → `ignored`. No card is created.

### AI charge check (Claude Haiku 5.5)

| | Anthropic (`ANTHROPIC_API_KEY`) | OpenRouter (`OPENROUTER_API_KEY`) |
|---|---|---|
| Endpoint | `api.anthropic.com/v1/messages` | `openrouter.ai/api/v1/chat/completions` |
| Model | `claude-haiku-5-5` | `anthropic/claude-haiku-5.5`, or the `OPENROUTER_MODEL` property |

If both keys are set, Anthropic is used. To keep cost minimal each call sends a
two-sentence instruction plus the notification text only (≤ 500 characters),
with thinking turned off and `max_tokens: 5`; the model answers one letter, `Y`
or `N`. That is roughly 100–150 input tokens and 1 output token per call — at
Haiku 5.5's $0.10 / $0.50 per million tokens, about ₱0.001 per notification.

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
