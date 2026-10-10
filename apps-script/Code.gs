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
 *   A Timestamp | B Date | C Amount | D Card | E Note
 *
 * Writes are exactly these five columns. appendRow places values by position,
 * so a sixth entry would spill into column F; if you ever add a column of your
 * own there, it stays yours.
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

    saveTransaction(amount, card, note, date);

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
function saveTransaction(amount, card, note, date) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    // Exactly five values, columns A-E. Nothing this script writes goes past E.
    getTransactionSheet().appendRow([
      new Date(),
      date ? new Date(date) : new Date(),
      Number(amount),
      cleanCard(card),
      note
    ]);
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
 * The card is found by last 4 on the "Cards" sheet, which the web app keeps
 * in step with its own list. A last 4 nobody has seen gets a new card,
 * "<bank> ••<last4>", which the web app adds to its list on its next load.
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
  if (last4.length !== 4) {
    return jsonResponse({ ok: false, code: 400, error: "last4 must be exactly 4 digits." });
  }

  let purchasedAt = new Date(String(body.timestamp || ""));
  if (isNaN(purchasedAt.getTime())) purchasedAt = new Date();

  // Midnight of the purchase day in the script's timezone — what the web app's
  // date picker produces for rows entered by hand.
  const date = parseDateInput(toDateKey(purchasedAt));

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    let card = findCardByLast4(last4, bank);
    let created = false;

    if (!card) {
      card = addCard({ bank: bank, last4: last4, name: (bank || "Card") + " ••" + last4, source: "shortcut" });
      created = true;
    }

    const rowNote = note || card.name;

    if (isRecentDuplicate(amount, card.name, rowNote, date)) {
      return jsonResponse({ ok: true, code: 200, status: "duplicate", card: card.name });
    }

    // Already under the lock, so append directly rather than via saveTransaction.
    getTransactionSheet().appendRow([new Date(), date, Number(amount), card.name, rowNote]);

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

/** By last 4. Only when two cards share it does the bank decide between them. */
function findCardByLast4(last4, bank) {
  const matches = readCards().filter(function (card) { return card.last4 === last4; });
  if (matches.length < 2) return matches[0] || null;

  const key = bankKey(bank);
  return matches.filter(function (card) { return bankKey(card.bank) === key; })[0] || matches[0];
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

    return jsonResponse({ ok: true, cards: readCards() });
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
