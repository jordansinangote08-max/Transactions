/**
 * Smart Card Advisor — Google Apps Script backend.
 *
 * One job: take a transaction from the web app and append it to the sheet.
 *
 *   write  index.html  --POST-->  doPost()  -->  "Transactions" sheet
 *   read   index.html  --GET--->  the sheet's published CSV
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

    return jsonResponse({
      ok: false,
      error: "Unknown action: " + action,
      actions: ["summary", "entries"]
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
