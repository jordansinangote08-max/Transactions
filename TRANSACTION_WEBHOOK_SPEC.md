# Spec: Auto-log card transactions from iPhone bank notifications

## Goal

An iOS 27 Shortcut fires when a bank app shows a purchase notification on the
iPhone, extracts the details, and POSTs them to this app. The app:

1. finds the card by its **last 4 digits**;
2. if there is no last 4, or no card has it, finds the card whose **name is
   nearest to the bank** the Shortcut sent;
3. if nothing matches, **creates a card** from the bank name (+ last 4),
   then logs the transaction to it. See [Card resolution](#card-resolution).

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

## Endpoint

```
POST https://script.google.com/macros/s/AKfycbyndwZXzpAAx2voFy8yvQEjr-0DC7NzP8RocThd76Qbyd-qx_lEneheHBYA7AeMbMQL/exec?token=<WEBHOOK_SECRET>
Content-Type: application/json
```

### Request body

All values are strings.

```json
{ "timestamp": "2026-05-24T20:15:00+08:00", "amount": "454", "last4": "1234", "bank": "EastWest", "note": "SM SUPERMARKET" }
```

| Field | Rules |
|---|---|
| `timestamp` | ISO 8601 time of the purchase. Missing or invalid → now. |
| `amount` | Required, > 0. Commas and `₱` are tolerated. |
| `last4` | Optional. Anything but exactly 4 digits counts as missing. |
| `bank` | Matched against card names when the last 4 doesn't find a card; names a new card. |
| `note` | Merchant. Empty → the card's name, like rows entered by hand. |

### Row written to Transactions

Same five columns the web app writes:

| Timestamp | Date | Amount | Card | Note |
|---|---|---|---|---|
| when the row was written | purchase day, midnight | `454` | card name | `note`, or the card name |

### Processing

1. `token` must equal `WEBHOOK_SECRET` (constant-time compare) → else `401`.
2. `amount` > 0, and at least one of `last4` / `bank` → else `400`.
3. Resolve the card (below).
4. None → add a card, source `shortcut`: `"<bank> ••<last4>"` (e.g. `BPI ••1234`)
   when there is a last 4, otherwise just `"<bank>"`. The web app adds it to its
   card list on its next load, with a placeholder statement/due schedule (and,
   without a last 4, no digits) to set in the card editor.
5. Same card + amount + note + day already written in the last 2 minutes → `duplicate`
   (iOS can fire one notification twice).
6. Append the row.

### Card resolution

Cards are looked up on the Cards tab, in this order:

1. **Last 4.** When `last4` is given and a card has it, that card. If two
   cards share it, the one whose name or bank is nearest to `bank`.
2. **Nearest name.** When there is no last 4, or no card has it, the card
   whose name is nearest to `bank`. Names are compared ignoring case, spaces
   and punctuation, and scored:

   | Score | Rule | Example (`bank` → card name) |
   |---|---|---|
   | 4 | Same | `Union Bank` → `UnionBank` |
   | 3 | One starts with the other | `BDO` → `BDO Gold` |
   | 2 | One contains the other | `Gold` → `BDO Gold` |
   | 1 | 1–2 typos, names of 5+ characters only | `Eastwset` → `EastWest` |

   Highest score wins; on a tie, the shortest name. Short names never
   fuzzy-match each other, so `BPI` does not match `BDO`.
3. **Nothing matched** → create a card (step 4 above).

Note that an unknown last 4 still falls through to the name: a new EastWest
card sent with `"last4":"1234","bank":"EastWest"` logs to the existing
`EastWest` card rather than creating `EastWest ••1234`.

### Responses

```json
{ "ok": true,  "code": 201, "status": "logged", "card": "EastWest", "card_id": "EW", "card_created": false }
{ "ok": true,  "code": 201, "status": "logged", "card": "BPI ••1234", "card_id": "SHORTCUT_…", "card_created": true }
{ "ok": true,  "code": 200, "status": "duplicate", "card": "EastWest" }
{ "ok": false, "code": 400, "error": "…" }
{ "ok": false, "code": 401, "error": "Unauthorized." }
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
   `WEBHOOK_SECRET` = a long random string (e.g. `openssl rand -hex 24`).
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
  -d '{"timestamp":"2026-05-24T20:15:00+08:00","amount":"454","last4":"3002","bank":"EastWest","note":""}'
```

| Case | Expect |
|---|---|
| Last 4 of an existing card | `logged`, `card_created: false` |
| New last 4 | `logged`, `card_created: true`; card appears in the app on next load |
| Same request again within 2 minutes | `duplicate` |
| No `last4`, `bank` near an existing card name | `logged` to that card |
| No `last4`, `bank` matching no card | `logged`, `card_created: true`, card named `<bank>` |
| Neither `last4` nor `bank` | `code: 400` |
| Wrong or missing token | `code: 401` |
| `amount` missing or `0` | `code: 400` |

## Privacy

`?action=cards` (like the existing `?action=entries`) is readable by anyone with
the web app URL. Only the webhook requires the token.
