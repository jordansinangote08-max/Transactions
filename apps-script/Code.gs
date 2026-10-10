/**
 * Smart Card Advisor — Google Apps Script backend.
 *
 * One job: take a transaction from the web app and append it to the sheet.
 *
 *   write  index.html  --POST-->  doPost()  -->  "Transactions" sheet
 *   delete index.html  --POST-->  doPost(action=delete) --> one row removed
 *   read   index.html  --GET--->  the sheet's published CSV
 *   cards  index.html  --POST-->  doPost(action=syncCards) --> "Cards" sheet
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

    // Only the iOS Shortcut sends a JSON body; the web app sends form fields.
    if (isJsonBody(e)) {
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
            note: entry.note
          };
        });

      return jsonResponse({ ok: true, count: entries.length, entries: entries });
    }

    if (action === "cards") {
      return jsonResponse({ ok: true, cards: readCards() });
    }

    return jsonResponse({
      ok: false,
      error: "Unknown action: " + action,
      actions: ["summary", "entries", "cards"]
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

  return rows.slice(1)
    .filter(function (row) {
      return row[1] !== "" && row[2] !== "";
    })
    .map(function (row) {
      return {
        date: new Date(row[1]),
        amount: Number(row[2]),
        card: cleanCard(row[3]),
        note: row[4]
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
 * The Shortcut posts, as JSON:
 *
 *   { "timestamp": "2026-05-24T20:15:00+08:00", "amount": "454",
 *     "last4": "1234", "bank": "EastWest", "note": "SM SUPERMARKET" }
 *
 * to WEB_APP_URL?token=<WEBHOOK_SECRET>. The row it produces is the same shape
 * the web app writes: Timestamp now, Date the purchase day at midnight, Card
 * the card's name, Note the merchant (or the card name when there is none).
 *
 * The card is resolved against the "Cards" sheet, which the web app keeps in
 * step with its own list (see resolveCard): by last 4, else by the card name
 * nearest to "bank", else a new card — "<bank> ••<last4>", or just "<bank>"
 * without a last 4 — which the web app adds to its list on its next load.
 *
 * Apps Script always answers HTTP 200, so the outcome is in "code" / "status".
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
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (error) {
    return jsonResponse({ ok: false, code: 400, error: "Body is not valid JSON." });
  }
  body = body && typeof body === "object" ? body : {};

  const token = (e.parameter && e.parameter.token) || body.token;
  if (!isValidToken(token)) {
    return jsonResponse({ ok: false, code: 401, error: "Unauthorized." });
  }

  const amount = parseMoney(body.amount);
  const last4 = String(body.last4 || "").replace(/\D/g, "");
  const bank = cleanCard(body.bank).slice(0, 40);
  const note = cleanCard(body.note).slice(0, 120);

  if (!Number.isFinite(amount) || amount <= 0) {
    return jsonResponse({ ok: false, code: 400, error: "amount must be a number greater than zero." });
  }
  // Anything but exactly four digits counts as no last 4.
  const knownLast4 = last4.length === 4 ? last4 : "";

  if (!knownLast4 && !bank) {
    return jsonResponse({ ok: false, code: 400, error: "Send last4 or bank, so the card can be found." });
  }

  let purchasedAt = new Date(String(body.timestamp || ""));
  if (isNaN(purchasedAt.getTime())) purchasedAt = new Date();

  // Midnight of the purchase day in the script's timezone — what the web app's
  // date picker produces for rows entered by hand.
  const date = parseDateInput(toDateKey(purchasedAt));

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    let card = resolveCard(knownLast4, bank);
    let created = false;

    if (!card) {
      card = addCard({
        bank: bank,
        last4: knownLast4,
        name: knownLast4 ? (bank || "Card") + " ••" + knownLast4 : bank,
        source: "shortcut"
      });
      created = true;
    }

    const rowNote = note || card.name;

    if (isRecentDuplicate(amount, card.name, rowNote, date)) {
      return jsonResponse({ ok: true, code: 200, status: "duplicate", card: card.name });
    }

    // Already under the lock, so append directly rather than via saveTransaction.
    appendTransaction(date, amount, card.name, rowNote, card.last4 || knownLast4);

    return jsonResponse({
      ok: true, code: 201, status: "logged",
      card: card.name, card_id: card.id, card_created: created
    });
  } catch (error) {
    // The message only — never the request, which carries the token.
    console.error("handleWebhook failed: " + error.message);
    return jsonResponse({ ok: false, code: 500, error: "Server error." });
  } finally {
    lock.releaseLock();
  }
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

function bankKey(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
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
 * Card resolution:
 *
 *   1. last 4, when given and some card has it — if two cards share it, the
 *      one whose bank or name is nearest to "bank";
 *   2. otherwise the card whose name is nearest to "bank" (nameScore);
 *   3. otherwise null, and the caller creates a card.
 */
function resolveCard(last4, bank) {
  const cards = readCards();

  if (last4) {
    const byLast4 = cards.filter(function (card) { return card.last4 === last4; });
    if (byLast4.length === 1) return byLast4[0];
    if (byLast4.length > 1) return nearestByName(byLast4, bank, true) || byLast4[0];
  }

  return bank ? nearestByName(cards, bank, false) : null;
}

/** The best-scoring card for "bank"; ties go to the shorter (closer) name. */
function nearestByName(cards, bank, includeBankField) {
  let best = null;
  let bestScore = 0;

  cards.forEach(function (card) {
    let score = nameScore(card.name, bank);
    if (includeBankField) score = Math.max(score, nameScore(card.bank, bank));

    if (score > bestScore ||
        (score === bestScore && score > 0 && card.name.length < best.name.length)) {
      best = card;
      bestScore = score;
    }
  });

  return best;
}

/**
 * How near a card name is to the bank the Shortcut sent, compared without
 * case, spaces or punctuation. 0 means not a match at all.
 *
 *   4  same            "Union Bank"  ~ "UNIONBANK"
 *   3  starts with     "BDO"         ~ "BDO Gold"
 *   2  contains        "Gold"        ~ "BDO Gold"
 *   1  1–2 typos       "Eastwset"    ~ "EastWest"   (names of 5+ characters
 *                                                    only, so BPI ≠ BDO)
 */
function nameScore(name, bank) {
  const a = bankKey(name);
  const b = bankKey(bank);
  if (!a || !b) return 0;

  if (a === b) return 4;
  if (a.indexOf(b) === 0 || b.indexOf(a) === 0) return 3;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 2;
  if (Math.min(a.length, b.length) >= 5 && editDistance(a, b) <= 2) return 1;
  return 0;
}

function editDistance(a, b) {
  let previous = [];
  for (var j = 0; j <= b.length; j++) previous[j] = j;

  for (var i = 1; i <= a.length; i++) {
    const current = [i];
    for (var k = 1; k <= b.length; k++) {
      current[k] = Math.min(
        previous[k] + 1,
        current[k - 1] + 1,
        previous[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

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
