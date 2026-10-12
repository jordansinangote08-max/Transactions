/**
 * Smart Card Advisor — Google Apps Script backend.
 *
 * One job: take a transaction from the web app and append it to the sheet.
 *
 *   write  index.html  --POST-->  doPost()  -->  "Transactions" sheet
 *   delete index.html  --POST-->  doPost(action=delete) --> one row removed
 *   read   index.html  --GET--->  the sheet's published CSV
 *   cards  index.html  --POST-->  doPost(action=syncCards) --> "Cards" sheet
 *   state  index.html  --POST-->  doPost(action=saveState) --> "Settings" sheet
 *          index.html  --GET--->  ?action=state  (cards, salary schedule)
 *   auto   iOS Shortcut --POST JSON--> doPost() --> handleWebhook() --> one row
 *
 * The iOS Shortcut path is the only one that needs a secret: the WEBHOOK_SECRET
 * script property, sent as ?token=… (Apps Script cannot read request headers).
 *
 * This script knows nothing about any particular bank. Card names, statement
 * days, due-date rules and credit limits all live in the web app, which is
 * where you edit them — whatever you called a card there is what lands in the
 * Card column here, verbatim.
 *
 * Sheet layout — column order is a contract, do not reorder:
 *
 *   A Timestamp | B Date | C Amount | D Card | E Note | F Last4
 *
 * Last4 is found by its header, not its position: it goes in F when F is free,
 * otherwise after the last used column, so a column of your own is never
 * overwritten (see getLast4Column). Rows written before it existed are filled
 * in from the Cards sheet by card name whenever the web app syncs its cards
 * (fillMissingLast4).
 *
 * The published CSV's header row must keep the names Date, Amount, Card and
 * Note, because index.html looks columns up by header name rather than index.
 */

const SHEET_NAME = "Transactions";


// ============================================================
// WEB APP ENTRY POINTS
// ============================================================

/**
 * Receives one transaction from the web app.
 *
 * The client posts with mode:"no-cors", so it cannot read this response — the
 * body is for you, in the Apps Script execution log, when something looks wrong.
 */
function doPost(e) {
  try {
    const params = (e && e.parameter) || {};

    // The iOS Shortcut sends a JSON body with ?token= on the URL; the web app
    // sends form fields and never a token. A token without an action is also
    // the Shortcut, posting its fields as a form instead of JSON.
    if (isJsonBody(e) || (params.token && !params.action)) {
      return handleWebhook(e);
    }

    const action = String(params.action || "").toLowerCase();

    if (action === "delete") {
      return doDelete(params);
    }

    if (action === "synccards") {
      return syncCards(params);
    }

    if (action === "deletecard") {
      return deleteCard(params);
    }

    if (action === "savestate") {
      return saveState(params);
    }

    const amount = parseMoney(params.amount);
    const card = cleanCard(params.card);
    const note = String(params.note || "Website").trim();
    const date = parseDateInput(params.date);

    if (!Number.isFinite(amount) || amount <= 0) {
      return jsonResponse({
        ok: false,
        error: "Amount must be a number greater than zero.",
        received: params.amount
      });
    }

    if (!card) {
      return jsonResponse({
        ok: false,
        error: "Card is required.",
        received: params.card
      });
    }

    saveTransaction(amount, card, note, date, params.last4);

    return jsonResponse({ ok: true, amount: amount, card: card, date: date });
  } catch (error) {
    console.error("doPost failed: " + error.message);
    return jsonResponse({ ok: false, error: error.message });
  }
}

/**
 * Read-only JSON view of the sheet.
 *
 *   ?action=summary            lifetime total per card
 *   ?action=entries[&card=X]   rows, newest first, optionally one card's
 *   ?action=cards              the "Cards" sheet
 *   ?action=ai                 AI token usage and live model status
 *
 * A web-app deployment set to "Anyone" makes every transaction readable by
 * anyone holding the URL — the same exposure the published CSV already has.
 * Restrict the deployment, or add a shared secret here, if that matters.
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const action = String(params.action || "summary").toLowerCase();

    if (action === "summary") {
      return jsonResponse({ ok: true, totals: getTotalsByCard() });
    }

    if (action === "entries") {
      const card = cleanCard(params.card);

      const entries = readTransactions()
        .filter(function (entry) { return !card || entry.card === card; })
        .sort(function (a, b) { return b.date - a.date; })
        .map(function (entry) {
          return {
            date: toDateKey(entry.date),
            amount: entry.amount,
            card: entry.card,
            note: entry.note,
            // When the row was written — the web app's history shows the last 48 hours.
            timestamp: entry.timestamp ? entry.timestamp.toISOString() : "",
            last4: entry.last4
          };
        });

      return jsonResponse({ ok: true, count: entries.length, entries: entries });
    }

    if (action === "cards") {
      return jsonResponse({ ok: true, cards: readCards() });
    }

    if (action === "state") {
      return jsonResponse({ ok: true, state: readState() });
    }

    if (action === "ai") {
      return jsonResponse({ ok: true, ai: readAiStatus() });
    }

    return jsonResponse({
      ok: false,
      error: "Unknown action: " + action,
      actions: ["summary", "entries", "cards", "state", "ai"]
    });
  } catch (error) {
    console.error("doGet failed: " + error.message);
    return jsonResponse({ ok: false, error: error.message });
  }
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================================
// SHEET ACCESS
// ============================================================

function getTransactionSheet() {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(SHEET_NAME);

  if (!sheet) {
    throw new Error("Sheet not found: " + SHEET_NAME);
  }

  return sheet;
}

/**
 * Appends one row.
 *
 * Two requests arriving together can both resolve the same last row, so the
 * write is serialised — without the lock one of them silently overwrites the
 * other.
 */
function saveTransaction(amount, card, note, date, last4) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    appendTransaction(date ? new Date(date) : new Date(), amount, card, note, last4);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Appends A-E, then the card's last 4 under the Last4 header. Without a last 4
 * from the caller it is looked up on the Cards sheet by card name. Callers hold
 * the script lock.
 */
function appendTransaction(date, amount, card, note, last4) {
  const sheet = getTransactionSheet();
  const name = cleanCard(card);
  const digits = last4Of(last4) || last4ForCardName(name);

  sheet.appendRow([new Date(), date, Number(amount), name, note]);

  if (digits) {
    sheet.getRange(sheet.getLastRow(), getLast4Column(sheet)).setValue(digits);
  }
}

/**
 * The Last4 column's number, adding the header if it is not there yet: in F
 * when F is empty, otherwise in the first column after the used ones. Plain
 * text, so "0123" keeps its leading zero.
 */
function getLast4Column(sheet) {
  const width = Math.max(sheet.getLastColumn(), 5);
  const headers = sheet.getRange(1, 1, 1, width).getValues()[0];

  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim().toLowerCase() === "last4") return i + 1;
  }

  const column = String(headers[5] === undefined ? "" : headers[5]).trim() === "" &&
    sheet.getRange(1, 6, Math.max(sheet.getLastRow(), 1), 1).getValues()
      .every(function (row) { return row[0] === ""; })
    ? 6
    : width + 1;

  sheet.getRange(1, column, sheet.getMaxRows(), 1).setNumberFormat("@");
  sheet.getRange(1, column).setValue("Last4");
  return column;
}

/** Card name or id → last 4, from the Cards sheet. */
function last4ByCard() {
  const map = {};
  readCards().forEach(function (card) {
    if (!card.last4) return;
    [card.name, card.id].forEach(function (key) {
      key = cleanCard(key).toLowerCase();
      if (key && !map[key]) map[key] = card.last4;
    });
  });
  return map;
}

function last4ForCardName(name) {
  return last4ByCard()[cleanCard(name).toLowerCase()] || "";
}

/**
 * Fills Last4 on every row that has a card but no last 4 yet, by matching the
 * Card cell (a card's name, or the id older rows carry, like "EW") against the
 * Cards sheet. Rows for a card the sheet does not know stay blank until it
 * does. Returns how many rows were filled. Callers hold the script lock.
 */
function fillMissingLast4() {
  const sheet = getTransactionSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const column = getLast4Column(sheet);
  const cards = sheet.getRange(2, 4, lastRow - 1, 1).getValues();
  const range = sheet.getRange(2, column, lastRow - 1, 1);
  const values = range.getValues();
  const map = last4ByCard();
  let filled = 0;

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() !== "") continue;
    const digits = map[cleanCard(cards[i][0]).toLowerCase()];
    if (digits) {
      values[i][0] = digits;
      filled++;
    }
  }

  if (filled) range.setValues(values);
  return filled;
}

/** Run from the Apps Script editor to backfill Last4 by hand. */
function backfillLast4() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    console.log("Filled Last4 on " + fillMissingLast4() + " rows.");
  } finally {
    lock.releaseLock();
  }
}

/**
 * Removes ONE row matching a transaction the web app deleted.
 *
 * The sheet has no id column, so the row is identified by date + amount + card +
 * note. Two genuinely identical transactions are therefore indistinguishable —
 * a second "120 / Grab / today" looks exactly like the first. The scan runs
 * bottom-up and stops at the first hit, so the newest match goes and the older
 * one survives; the total stays right either way, but which row went is not
 * knowable. That is the accepted cost of having no id to key on.
 *
 * It never deletes more than one row, whatever matches.
 */
function doDelete(params) {
  const amount = parseMoney(params.amount);
  const card = cleanCard(params.card);
  const note = String(params.note || "").trim().toLowerCase();
  const dateKey = toDateKey(parseDateInput(params.date));

  if (!Number.isFinite(amount) || !card) {
    return jsonResponse({ ok: false, error: "Amount and card are required to delete." });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    const sheet = getTransactionSheet();
    const rows = sheet.getDataRange().getValues();

    // Bottom-up: row 1 is the header, so stop before it.
    for (var i = rows.length - 1; i >= 1; i--) {
      const row = rows[i];
      if (!row[1] && !row[2]) continue;

      const sameDate = toDateKey(new Date(row[1])) === dateKey;
      const sameAmount = Math.round(Number(row[2]) * 100) === Math.round(amount * 100);
      const sameCard = cleanCard(row[3]).toLowerCase() === card.toLowerCase();
      const sameNote = String(row[4] || "").trim().toLowerCase() === note;

      if (sameDate && sameAmount && sameCard && sameNote) {
        sheet.deleteRow(i + 1);   // getValues is 0-based, the sheet is 1-based
        return jsonResponse({ ok: true, deleted: true, row: i + 1 });
      }
    }

    // Not an error: the row may have been removed in the spreadsheet already.
    return jsonResponse({ ok: true, deleted: false, reason: "No matching row." });
  } finally {
    lock.releaseLock();
  }
}

/** Every data row as {date, amount, card, note}, header row dropped. */
function readTransactions() {
  const rows = getTransactionSheet().getDataRange().getValues();
  const headers = rows[0] || [];
  let last4Index = -1;
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim().toLowerCase() === "last4") last4Index = i;
  }

  return rows.slice(1)
    .filter(function (row) {
      return row[1] !== "" && row[2] !== "";
    })
    .map(function (row) {
      const written = row[0] instanceof Date ? row[0] : new Date(row[0]);
      return {
        timestamp: isNaN(written.getTime()) ? null : written,
        date: new Date(row[1]),
        amount: Number(row[2]),
        card: cleanCard(row[3]),
        note: row[4],
        last4: last4Index === -1 ? "" : last4Of(row[last4Index])
      };
    });
}

/** Lifetime total per card, keyed by whatever the card is called. */
function getTotalsByCard() {
  const totals = {};

  readTransactions().forEach(function (entry) {
    if (!entry.card || !Number.isFinite(entry.amount)) return;
    totals[entry.card] = (totals[entry.card] || 0) + entry.amount;
  });

  return totals;
}


// ============================================================
// PARSING
// ============================================================

/**
 * The card as the web app named it, trimmed and with runs of whitespace
 * collapsed so "Union  Bank" and "Union Bank" do not become two cards.
 *
 * Deliberately no alias table and no list of known cards: the web app decides
 * what cards exist and what they are called, and anything it sends is saved
 * as-is.
 */
function cleanCard(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

/** Accepts 1234, "1,234", "₱1,234.50". Returns NaN when it is not a number, so
 *  callers can tell "unparseable" from a genuine zero. */
function parseMoney(value) {
  if (value === null || value === undefined || value === "") return NaN;

  return Number(String(value).replace(/[₱,\s]/g, "").trim());
}

/**
 * The web app sends an <input type="date"> value, "YYYY-MM-DD".
 * new Date("2026-09-25") parses as UTC midnight, which lands on the previous
 * day in any timezone behind UTC, so date-only strings are built as a local
 * date instead. Anything else falls back to Date parsing, and unusable input
 * becomes today rather than an Invalid Date written into the sheet.
 */
function parseDateInput(value) {
  if (!value) return new Date();

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());

  if (dateOnly) {
    return new Date(
      Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])
    );
  }

  const parsed = new Date(value);

  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

function toDateKey(date) {
  return Utilities.formatDate(
    date, Session.getScriptTimeZone(), "yyyy-MM-dd"
  );
}



// ============================================================
// iOS SHORTCUT WEBHOOK
// ============================================================

/**
 * The Shortcut posts, as JSON, to WEB_APP_URL?token=<WEBHOOK_SECRET>:
 *
 *   { "timestamp": "2026-10-10T15:41:00+08:00", "amount": "69.00", "last4": "",
 *     "note": "TikTok Shop Seller",
 *     "raw": "A MariBank Credit Card transaction of PHP 69.00 at TikTok Shop …" }
 *
 * "raw" is the whole notification (older Shortcuts without it fall back to
 * "note"). A row is written only for a charge on a card saved in the web app:
 *
 *   1. card    a saved card's last 4 in the notification, else a saved card's
 *              FULL name ("MariBank Credit Card" matches "Mari Bank Credit Card",
 *              but a notification saying only "MariBank" does not)
 *              → no saved card: "ignored", and no AI call is made
 *   2. amount  the phone's, else the first PHP / ₱ / P amount in the text → else 400
 *   3. same card + amount + note on the same day within 2 minutes → "duplicate"
 *   4. AI      Claude Haiku 5.5 answers one letter: is this a charge (money out)?
 *              N → "ignored"; no answer → 503 and nothing written
 *   5. one row in the usual Timestamp | Date | Amount | Card | Note shape
 *
 * Steps 1–3 cost nothing, so the AI is asked only about notifications that
 * would otherwise be written. Apps Script always answers HTTP 200; the outcome
 * is in "code" / "status".
 */
const CARDS_SHEET = "Cards";
const CARDS_HEADERS = ["ID", "Bank", "Last4", "Name", "Source", "Created"];
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

function isJsonBody(e) {
  const post = e && e.postData;
  if (!post || !post.contents) return false;

  return String(post.type || "").toLowerCase().indexOf("json") !== -1 ||
    /^\s*\{/.test(post.contents);
}

function handleWebhook(e) {
  const params = (e && e.parameter) || {};
  const body = readWebhookBody(e);

  const token = params.token || body.token;
  if (!isValidToken(token)) {
    return jsonResponse({ ok: false, code: 401, error: "Unauthorized." });
  }

  // Every 400 echoes what arrived, minus the token, so it can be read on the phone.
  const badRequest = function (message) {
    const received = {};
    Object.keys(body).forEach(function (key) {
      if (key !== "token") received[key] = body[key];
    });
    const post = e && e.postData;
    return jsonResponse({
      ok: false, code: 400, error: message,
      received: received,
      content_type: post ? String(post.type || "") : "(no body)",
      // The raw body too, unless the token travelled in it.
      raw: post && post.contents && !body.token ? String(post.contents).slice(0, 500) : ""
    });
  };

  const raw = String(firstValue(body.raw) || firstValue(body.note))
    .replace(/\s+/g, " ").trim().slice(0, 500);
  const note = cleanCard(firstValue(body.note)).slice(0, 120);
  const last4 = String(firstValue(body.last4)).replace(/\D/g, "");

  // 1. Only cards saved in the web app. Nothing to log otherwise, so no AI call.
  const card = findSavedCard(readCards(), last4.length === 4 ? last4 : "", raw);
  if (!card) {
    return jsonResponse({ ok: true, code: 200, status: "ignored", reason: "No saved card in the notification." });
  }

  // 2. The phone's amount, else the first amount in the notification.
  const sent = parseAmount(body.amount);
  const amount = Math.round((sent > 0 ? sent : amountFromText(raw)) * 100) / 100;
  if (!(amount > 0)) {
    return badRequest("amount must be a number greater than zero.");
  }

  let purchasedAt = new Date(String(firstValue(body.timestamp)));
  if (isNaN(purchasedAt.getTime())) purchasedAt = new Date();

  // Midnight of the purchase day in the script's timezone — what the web app's
  // date picker produces for rows entered by hand.
  const date = parseDateInput(toDateKey(purchasedAt));

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    const rowNote = note || card.name;

    // 3. Before the AI, so a notification iOS delivers twice is not paid for twice.
    if (isRecentDuplicate(amount, card.name, rowNote, date)) {
      return jsonResponse({ ok: true, code: 200, status: "duplicate", card: card.name });
    }

    // 4. Is it money going out? Refunds, cash in, cashback, promos and notices are not.
    const charge = isChargeByAI(raw);
    if (charge === null) {
      return jsonResponse({ ok: false, code: 503, status: "unverified", error: "Could not reach the AI to verify the charge; nothing was saved." });
    }
    if (!charge) {
      return jsonResponse({ ok: true, code: 200, status: "ignored", reason: "Not a charge.", card: card.name });
    }

    // Already under the lock, so append directly rather than via saveTransaction.
    appendTransaction(date, amount, card.name, rowNote, card.last4);

    return jsonResponse({ ok: true, code: 201, status: "logged", card: card.name, amount: amount, note: rowNote });
  } catch (error) {
    // The message only — never the request, which carries the token.
    console.error("handleWebhook failed: " + error.message);
    return jsonResponse({ ok: false, code: 500, error: "Server error." });
  } finally {
    lock.releaseLock();
  }
}

/**
 * The Shortcut's fields: JSON.parse(e.postData.contents), or e.parameter when
 * there is no body or it is not a JSON object (a Shortcut set to send a form).
 */
function readWebhookBody(e) {
  const post = e && e.postData;

  if (post && post.contents) {
    try {
      const parsed = JSON.parse(post.contents);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (error) {
      // Not JSON; fall through to the form fields.
    }
  }

  return (e && e.parameter) || {};
}

/** Shortcuts' "Match Text" yields a list; take its first item. */
function firstValue(value) {
  if (Array.isArray(value)) value = value[0];
  return value === null || value === undefined ? "" : value;
}

/**
 * The amount as the Shortcut sends it: a number, or a string like "454.00",
 * "1,250.50", "₱454", "PHP 454.00" or "Php454". Commas and any currency text
 * are dropped and the first number in what remains is parsed. NaN when there
 * is none.
 */
function parseAmount(value) {
  value = firstValue(value);
  if (typeof value === "number") return value;

  const match = /\d+(?:\.\d+)?|\.\d+/.exec(String(value).replace(/,/g, ""));
  return match ? parseFloat(match[0]) : NaN;
}

/** Constant-time comparison against the WEBHOOK_SECRET script property. */
function isValidToken(token) {
  const secret = PropertiesService.getScriptProperties().getProperty("WEBHOOK_SECRET");
  if (!secret || !token) return false;

  const a = String(token);
  let diff = a.length ^ secret.length;
  for (var i = 0; i < secret.length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ secret.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * iOS can deliver one notification twice. The same card, amount, note and day
 * written within the last two minutes is taken to be that.
 */
function isRecentDuplicate(amount, cardName, note, date) {
  const rows = getTransactionSheet().getDataRange().getValues();
  const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
  const dateKey = toDateKey(date);

  for (var i = rows.length - 1; i >= 1 && i >= rows.length - 50; i--) {
    const row = rows[i];
    if (!(row[0] instanceof Date) || row[0].getTime() < cutoff) continue;

    if (toDateKey(new Date(row[1])) === dateKey &&
        Math.round(Number(row[2]) * 100) === Math.round(amount * 100) &&
        cleanCard(row[3]).toLowerCase() === cardName.toLowerCase() &&
        String(row[4] || "").trim().toLowerCase() === note.toLowerCase()) {
      return true;
    }
  }
  return false;
}


// ============================================================
// CARDS SHEET
// ============================================================

/**
 * The web app owns the card list and keeps it in the browser; this sheet is a
 * copy the webhook can search by last 4, plus the cards the webhook created.
 *
 *   A ID | B Bank | C Last4 | D Name | E Source (app | shortcut) | F Created
 */
function getCardsSheet() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(CARDS_SHEET);

  if (!sheet) {
    sheet = book.insertSheet(CARDS_SHEET);
    sheet.appendRow(CARDS_HEADERS);
    sheet.setFrozenRows(1);
    // Plain text, so a last 4 like "0123" keeps its leading zero.
    sheet.getRange("C:C").setNumberFormat("@");
  }
  return sheet;
}

/** The sheet may still have turned "0123" into 123; pad it back. */
function last4Of(value) {
  const digits = String(value === null || value === undefined ? "" : value).replace(/\D/g, "");
  return digits ? ("0000" + digits).slice(-4) : "";
}

function readCards() {
  return getCardsSheet().getDataRange().getValues().slice(1)
    .filter(function (row) { return row[0]; })
    .map(function (row) {
      return {
        id: String(row[0]),
        bank: String(row[1] || ""),
        last4: last4Of(row[2]),
        name: cleanCard(row[3]),
        source: String(row[4] || "app")
      };
    });
}

/**
 * The saved card a notification is about, or null:
 *
 *   1. last 4  the phone's last 4, or a saved card's last 4 standing on its own
 *              in the text ("Visa 4069", "ending in 4069"; not "4,069.00");
 *   2. name    a saved card's FULL name, compared without case, spaces or
 *              punctuation — "MariBank Credit Card" matches "Mari Bank credit
 *              card" but not "MariBank". The longest name wins, so "BPI Gold"
 *              beats "BPI". A name match is refused when the phone sent a
 *              different last 4: that is another card from the same bank.
 */
function findSavedCard(cards, last4, raw) {
  const byLast4 = cards.filter(function (card) {
    return card.last4 && (card.last4 === last4 || hasLast4(raw, card.last4));
  })[0];
  if (byLast4) return byLast4;

  const text = compactName(raw);
  if (!text) return null;

  return cards
    .filter(function (card) {
      const name = compactName(card.name);
      return name.length >= 3 && text.indexOf(name) !== -1 &&
        !(last4 && card.last4 && card.last4 !== last4);
    })
    .sort(function (a, b) { return compactName(b.name).length - compactName(a.name).length; })[0] || null;
}

function compactName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The four digits as a number of their own, not part of a longer number or an amount. */
function hasLast4(text, digits) {
  return new RegExp("(^|[^\\d.,])" + digits + "(?!\\d|[.,]\\d)").test(String(text || ""));
}

/** First amount after PHP / Php / ₱ / P in the text, or NaN. */
function amountFromText(raw) {
  const m = /(?:PHP|Php|php|₱|(?:^|[^A-Za-z])P)\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/.exec(String(raw || ""));
  return m ? parseFloat(m[1].replace(/,/g, "")) : NaN;
}


// ============================================================
// AI CHARGE CHECK (Claude Haiku 5.5, direct or through OpenRouter)
// ============================================================

/**
 * Script Properties (Project Settings → Script Properties), set ONE of:
 *
 *   ANTHROPIC_API_KEY   calls Anthropic directly        (used if both are set)
 *   OPENROUTER_API_KEY  calls the same model via OpenRouter
 *   OPENROUTER_MODEL    optional: OpenRouter's id for Haiku 5.5, if it differs
 *                       from the default below
 *
 * Kept as cheap as possible: a two-line instruction, the notification text
 * only (max 500 characters), thinking off, and a one-letter answer — roughly
 * 100–150 input tokens and 1 output token per call.
 */
const AI_MODEL = "claude-haiku-5-5";
const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
const AI_INSTRUCTION =
  "Reply Y if this phone notification is a card charge: money spent, paid or deducted. " +
  "Reply N for anything else: refund, reversal, cash in, received or added funds, cashback, rewards, promo, OTP, login or account notice.";

/** true = a charge, false = not a charge, null = no usable answer. */
function isChargeByAI(raw) {
  const ai = aiConfig();
  if (!raw || !ai.api) {
    console.warn("AI check skipped: " + (raw ? "no ANTHROPIC_API_KEY or OPENROUTER_API_KEY set." : "empty notification."));
    return null;
  }

  let call;
  try {
    call = ai.api === "Anthropic" ? askAnthropic(ai.key, raw) : askOpenRouter(ai.key, ai.model, raw);
  } catch (error) {
    call = { http: 0, error: error.message };
  }

  const letter = String(call.text || "").trim().charAt(0).toUpperCase();
  const result = letter === "Y" ? true : letter === "N" ? false : null;

  recordAiCall({
    feature: "Charge check (iPhone Shortcut)",
    api: ai.api,
    model: call.model || ai.model,
    input: call.input || 0,
    output: call.output || 0,
    result: result === true ? "charge" : result === false ? "not a charge" : "no answer",
    http: call.http,
    error: call.error || ""
  });

  if (call.error) console.warn("AI check failed: " + call.error);
  return result;
}

/** Which provider and model are in use, from the Script Properties. */
function aiConfig() {
  const props = PropertiesService.getScriptProperties();
  const anthropicKey = props.getProperty("ANTHROPIC_API_KEY");
  const openrouterKey = props.getProperty("OPENROUTER_API_KEY");

  if (anthropicKey) return { api: "Anthropic", key: anthropicKey, model: AI_MODEL };
  if (openrouterKey) return { api: "OpenRouter", key: openrouterKey, model: props.getProperty("OPENROUTER_MODEL") || OPENROUTER_DEFAULT_MODEL };
  return { api: "", key: "", model: AI_MODEL };
}

/** The API's error message, when its body has one. */
function apiErrorMessage(response) {
  try {
    const body = JSON.parse(response.getContentText());
    return (body.error && (body.error.message || body.error)) || body.message || "";
  } catch (error) {
    return "";
  }
}

/**
 * Returns {text, model, input, output, http, error}. "model" is the model the
 * API says answered — not the one asked for — so the AI panel shows what really ran.
 */
function askAnthropic(key, raw) {
  const response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 5,
      // No thinking tokens: allowed on Haiku 5.5 at effort low.
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: AI_INSTRUCTION,
      messages: [{ role: "user", content: raw }]
    }),
    muteHttpExceptions: true
  });

  const http = response.getResponseCode();
  if (http !== 200) {
    return { http: http, error: "Anthropic HTTP " + http + ": " + apiErrorMessage(response) };
  }

  const message = JSON.parse(response.getContentText());
  const usage = message.usage || {};
  return {
    http: http,
    model: message.model,
    input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
    output: usage.output_tokens || 0,
    text: message.stop_reason === "refusal" ? "" : (message.content || [])
      .filter(function (block) { return block.type === "text"; })
      .map(function (block) { return block.text; })
      .join("")
  };
}

function askOpenRouter(key, model, raw) {
  const response = UrlFetchApp.fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + key },
    payload: JSON.stringify({
      model: model,
      max_tokens: 5,
      reasoning: { enabled: false },
      messages: [
        { role: "system", content: AI_INSTRUCTION },
        { role: "user", content: raw }
      ]
    }),
    muteHttpExceptions: true
  });

  const http = response.getResponseCode();
  if (http !== 200) {
    return { http: http, error: "OpenRouter HTTP " + http + ": " + apiErrorMessage(response) };
  }

  const body = JSON.parse(response.getContentText());
  const choice = (body.choices || [])[0];
  const usage = body.usage || {};
  return {
    http: http,
    model: body.model,
    input: usage.prompt_tokens || 0,
    output: usage.completion_tokens || 0,
    text: choice && choice.message ? choice.message.content : ""
  };
}


// ============================================================
// AI USAGE AND STATUS (the web app's "AI" panel)
// ============================================================

/**
 * Every AI call the app makes is one row here, with the token counts and the
 * model the API itself reported:
 *
 *   A Timestamp | B Feature | C API | D Model | E Input tokens | F Output tokens |
 *   G Result | H HTTP | I Error
 *
 * Today the only AI feature is the iPhone Shortcut's charge check; the web app
 * page and the Google Sheet make no AI calls of their own. Anything that calls
 * AI later should go through recordAiCall too, so the panel stays complete.
 */
const AI_USAGE_SHEET = "AI Usage";
const AI_USAGE_HEADERS = ["Timestamp", "Feature", "API", "Model", "Input tokens", "Output tokens", "Result", "HTTP", "Error"];

/** USD per million tokens, for the cost estimate. Models not listed show no cost. */
const AI_PRICES = {
  "claude-haiku-5-5": { input: 0.10, output: 0.50 },
  "anthropic/claude-haiku-5.5": { input: 0.10, output: 0.50 }
};

function getAiUsageSheet() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(AI_USAGE_SHEET);

  if (!sheet) {
    sheet = book.insertSheet(AI_USAGE_SHEET);
    sheet.appendRow(AI_USAGE_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function recordAiCall(call) {
  try {
    getAiUsageSheet().appendRow([
      new Date(), call.feature, call.api, call.model || "",
      Number(call.input) || 0, Number(call.output) || 0,
      call.result, call.http || "", String(call.error || "").slice(0, 300)
    ]);
  } catch (error) {
    // Losing a usage row must never lose the transaction.
    console.warn("Could not record AI usage: " + error.message);
  }
}

function priceFor(model) {
  const key = String(model || "").toLowerCase();
  if (AI_PRICES[key]) return AI_PRICES[key];
  // The API may answer with a dated or prefixed id for the same model.
  if (key.indexOf("haiku-5-5") !== -1 || key.indexOf("haiku-5.5") !== -1) return AI_PRICES["claude-haiku-5-5"];
  return null;
}

/** What a call's failure means: "no_credits", "invalid_key", "rate_limited" or "error". */
function failureKind(http, error) {
  const text = String(error || "").toLowerCase();
  if (http === 402 || /credit|balance|insufficient|quota|billing/.test(text)) return "no_credits";
  if (http === 401 || http === 403) return "invalid_key";
  if (http === 429) return "rate_limited";
  return "error";
}

/**
 * A free check that the key works and the model is available — no tokens are
 * used. Anthropic: GET /v1/models/{model}. OpenRouter: GET /api/v1/credits for
 * the balance, and the model's endpoints. Cached 30 seconds.
 */
function liveAiCheck(ai) {
  if (!ai.api) return { state: "not_configured", detail: "No ANTHROPIC_API_KEY or OPENROUTER_API_KEY in Script Properties." };

  const cache = CacheService.getScriptCache();
  const cacheKey = "ai-live:" + ai.api + ":" + ai.model;
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  let result;
  try {
    if (ai.api === "Anthropic") {
      const response = UrlFetchApp.fetch("https://api.anthropic.com/v1/models/" + encodeURIComponent(ai.model), {
        headers: { "x-api-key": ai.key, "anthropic-version": "2023-06-01" },
        muteHttpExceptions: true
      });
      const http = response.getResponseCode();
      if (http === 200) {
        const model = JSON.parse(response.getContentText());
        result = { state: "live", detail: "Key accepted; model available.", model: model.id, model_name: model.display_name || "" };
      } else if (http === 404) {
        result = { state: "error", detail: "Model " + ai.model + " is not available to this key." };
      } else {
        result = { state: failureKind(http, apiErrorMessage(response)), detail: "HTTP " + http + ": " + apiErrorMessage(response) };
      }
    } else {
      const headers = { Authorization: "Bearer " + ai.key };
      const credits = UrlFetchApp.fetch("https://openrouter.ai/api/v1/credits", { headers: headers, muteHttpExceptions: true });
      const http = credits.getResponseCode();

      if (http !== 200) {
        result = { state: failureKind(http, apiErrorMessage(credits)), detail: "HTTP " + http + ": " + apiErrorMessage(credits) };
      } else {
        const data = JSON.parse(credits.getContentText()).data || {};
        const remaining = Number(data.total_credits || 0) - Number(data.total_usage || 0);
        result = remaining <= 0
          ? { state: "no_credits", detail: "OpenRouter credits used up." }
          : { state: "live", detail: "Key accepted." };
        result.credits_remaining_usd = Math.round(remaining * 10000) / 10000;

        const endpoints = UrlFetchApp.fetch("https://openrouter.ai/api/v1/models/" + ai.model + "/endpoints", { headers: headers, muteHttpExceptions: true });
        if (endpoints.getResponseCode() === 404) {
          result = { state: "error", detail: "OpenRouter has no model " + ai.model + ". Set OPENROUTER_MODEL to its id.", credits_remaining_usd: result.credits_remaining_usd };
        }
      }
    }
  } catch (error) {
    result = { state: "error", detail: "Could not reach " + ai.api + ": " + error.message };
  }

  result.checked_at = new Date().toISOString();
  cache.put(cacheKey, JSON.stringify(result), 30);
  return result;
}

/** ?action=ai — what the web app's AI panel shows. */
function readAiStatus() {
  const ai = aiConfig();
  const live = liveAiCheck(ai);

  const rows = getAiUsageSheet().getDataRange().getValues().slice(1).filter(function (row) { return row[0]; });
  const calls = rows.map(function (row) {
    return {
      at: (row[0] instanceof Date ? row[0] : new Date(row[0])),
      feature: String(row[1]), api: String(row[2]), model: String(row[3]),
      input: Number(row[4]) || 0, output: Number(row[5]) || 0,
      result: String(row[6]), http: Number(row[7]) || 0, error: String(row[8] || "")
    };
  });

  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  const month = today.slice(0, 7);

  function total(list) {
    const sum = { calls: list.length, input: 0, output: 0, cost_usd: 0, failed: 0 };
    list.forEach(function (call) {
      sum.input += call.input;
      sum.output += call.output;
      if (call.result === "no answer") sum.failed++;
      const price = priceFor(call.model);
      if (price) sum.cost_usd += (call.input * price.input + call.output * price.output) / 1e6;
    });
    sum.total = sum.input + sum.output;
    sum.cost_usd = Math.round(sum.cost_usd * 1e6) / 1e6;
    return sum;
  }

  function groupBy(field) {
    const groups = {};
    calls.forEach(function (call) { (groups[call[field]] = groups[call[field]] || []).push(call); });
    return Object.keys(groups).map(function (name) {
      const sum = total(groups[name]);
      sum.name = name;
      return sum;
    }).sort(function (a, b) { return b.total - a.total; });
  }

  const dayOf = function (call) { return Utilities.formatDate(call.at, tz, "yyyy-MM-dd"); };
  const last = calls[calls.length - 1] || null;
  const lastOk = last && last.result !== "no answer";

  // The model actually answering: what the API reported on the latest call,
  // else what the live check confirmed, else what is configured.
  const modelInUse = (last && lastOk && last.api === ai.api && last.model) || live.model || ai.model;

  let status = live.state;
  let detail = live.detail;
  if (live.state === "live" && last && last.api === ai.api) {
    status = lastOk ? "working" : failureKind(last.http, last.error);
    if (!lastOk) detail = last.error || "The latest AI call gave no answer.";
  }

  return {
    api: ai.api || "Not configured",
    model: modelInUse,
    configured_model: ai.model,
    status: status,
    status_detail: detail,
    credits_remaining_usd: live.credits_remaining_usd,
    checked_at: live.checked_at,
    last_call: last ? {
      at: last.at.toISOString(), model: last.model, result: last.result,
      input: last.input, output: last.output, error: last.error
    } : null,
    usage: {
      today: total(calls.filter(function (call) { return dayOf(call) === today; })),
      month: total(calls.filter(function (call) { return dayOf(call).slice(0, 7) === month; })),
      all: total(calls)
    },
    by_feature: groupBy("feature"),
    by_model: groupBy("model"),
    recent: calls.slice(-15).reverse().map(function (call) {
      return { at: call.at.toISOString(), feature: call.feature, model: call.model, input: call.input, output: call.output, result: call.result };
    })
  };
}


// ============================================================
// CARDS SHEET (continued)
// ============================================================

function addCard(card) {
  const record = {
    id: card.id || "SHORTCUT_" + Date.now(),
    bank: card.bank || "",
    last4: card.last4,
    name: cleanCard(card.name),
    source: card.source || "app"
  };
  getCardsSheet().appendRow([record.id, record.bank, record.last4, record.name, record.source, new Date()]);
  return record;
}

function findCardRow(sheet, id) {
  const ids = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), 1).getValues();
  for (var i = 1; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 1;
  }
  return 0;
}

/**
 * From the web app: payload is a JSON array of {id, name, last4, bank}. Each
 * card updates the row with its id, or else the row with its last 4 (a card the
 * Shortcut created before the app knew it), or is added. Rows the app does not
 * mention are left alone — they may be Shortcut cards it has not loaded yet.
 */
function syncCards(params) {
  let list;
  try {
    list = JSON.parse(params.payload || "[]");
  } catch (error) {
    list = null;
  }
  if (!Array.isArray(list)) {
    return jsonResponse({ ok: false, error: "payload must be a JSON array." });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    const sheet = getCardsSheet();

    list.forEach(function (item) {
      const last4 = last4Of(item && item.last4);
      if (!item || !item.id || last4.length !== 4) return;

      const cards = readCards();
      const existing =
        cards.filter(function (card) { return card.id === String(item.id); })[0] ||
        cards.filter(function (card) { return card.last4 === last4 && card.source === "shortcut"; })[0];

      const name = cleanCard(item.name).slice(0, 80);
      const bank = cleanCard(item.bank).slice(0, 40);

      if (existing) {
        const row = findCardRow(sheet, existing.id);
        sheet.getRange(row, 1, 1, 4).setValues([[String(item.id), bank || existing.bank, last4, name || existing.name]]);
      } else {
        addCard({ id: String(item.id), bank: bank, last4: last4, name: name, source: "app" });
      }
    });

    // Every name the app knows now has a last 4 here, so older rows can get theirs.
    const filled = fillMissingLast4();

    return jsonResponse({ ok: true, cards: readCards(), last4_filled: filled });
  } finally {
    lock.releaseLock();
  }
}

/** The web app deleted a card, so the Shortcut should stop matching it. */
function deleteCard(params) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    const sheet = getCardsSheet();
    const row = findCardRow(sheet, params.id);
    if (row) sheet.deleteRow(row);
    return jsonResponse({ ok: true, deleted: !!row });
  } finally {
    lock.releaseLock();
  }
}



// ============================================================
// APP STATE (cards and salary schedule, shared by every device)
// ============================================================

/**
 * The web app used to keep its cards and salary schedule only in the browser,
 * so each phone or computer had its own. They now live here, one JSON value
 * per key, and every device loads them on open and saves them on change.
 *
 *   A Key | B Value (JSON) | C Updated
 *
 *   cards   {customCards, builtInOverrides, deletedBuiltIns}
 *   salary  {frequency, day1, dayA, dayB, weekday}
 *
 * Last write wins. Like the app's other writes, this is not authenticated.
 */
const SETTINGS_SHEET = "Settings";
const STATE_KEYS = ["cards", "salary"];
const MAX_STATE_CHARS = 45000;   // a Sheets cell holds 50,000

function getSettingsSheet() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SETTINGS_SHEET);

  if (!sheet) {
    sheet = book.insertSheet(SETTINGS_SHEET);
    sheet.appendRow(["Key", "Value", "Updated"]);
    sheet.setFrozenRows(1);
    sheet.getRange("B:B").setNumberFormat("@");
  }
  return sheet;
}

function readState() {
  const state = {};

  getSettingsSheet().getDataRange().getValues().slice(1).forEach(function (row) {
    const key = String(row[0]);
    if (STATE_KEYS.indexOf(key) === -1 || row[1] === "") return;
    try {
      state[key] = JSON.parse(row[1]);
    } catch (error) {
      console.warn("Settings value for " + key + " is not JSON; ignored.");
    }
  });

  return state;
}

function saveState(params) {
  const key = String(params.key || "");
  const value = String(params.value || "");

  if (STATE_KEYS.indexOf(key) === -1) {
    return jsonResponse({ ok: false, error: "Unknown key: " + key });
  }
  if (value.length > MAX_STATE_CHARS) {
    return jsonResponse({ ok: false, error: "Value too large." });
  }
  try {
    JSON.parse(value);
  } catch (error) {
    return jsonResponse({ ok: false, error: "Value must be JSON." });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    const sheet = getSettingsSheet();
    const keys = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues();
    let row = 0;
    for (var i = 1; i < keys.length; i++) {
      if (String(keys[i][0]) === key) row = i + 1;
    }

    if (row) {
      sheet.getRange(row, 2, 1, 2).setValues([[value, new Date()]]);
    } else {
      sheet.appendRow([key, value, new Date()]);
    }
    return jsonResponse({ ok: true, key: key });
  } finally {
    lock.releaseLock();
  }
}
