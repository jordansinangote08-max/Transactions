/**
 * Smart Card Advisor — Google Apps Script backend.
 *
 * The web app (index.html) talks to this script and to the spreadsheet:
 *
 *   write  index.html  --POST-->  doPost()  -->  "Transactions" sheet
 *   read   index.html  --GET--->  the sheet's published CSV
 *
 * doGet() below also exposes the billing engine as JSON. The web app does not
 * call it yet — it computes statement dates client-side and reads rows from the
 * published CSV — but it is here so the period rules have a single source of
 * truth if you ever want the server to be authoritative.
 *
 * Sheet layout — column order is a contract, do not reorder:
 *
 *   A Timestamp | B Date | C Amount | D Card | E Note | F Card Name
 *
 * Card holds the id the web app uses as its matching key — "EW", "UB", "RCBC",
 * or a generated CUSTOM_<timestamp> — so it must stay stable. Card Name holds
 * the label you typed ("MariBank"), purely so the sheet is readable.
 *
 * The published CSV's header row must keep the names Date, Amount, Card and
 * Note, because index.html looks columns up by header name rather than index.
 */

const SHEET_NAME = "Transactions";

/** Fallback limits for the three built-in cards, in pesos. Anything set through
 *  setCreditLimit() is stored in Script Properties and wins over these. */
const DEFAULT_CREDIT_LIMITS = {
  UB: 33000,
  EW: 93000,
  RCBC: 70000
};

/** Share of the credit limit treated as spendable in one cycle. Note this is a
 *  self-imposed cap, not the bank's available credit: getAvailableCredit()
 *  returns (limit x this) - spent, so with a 33,000 limit the ceiling is 6,600. */
const AVAILABLE_CREDIT_PERCENT = 0.20;

/** Public Philippine holiday calendar, used to shift statement and due dates off
 *  non-business days. */
const PH_HOLIDAY_CALENDAR_ID =
  "en.philippines#holiday@group.v.calendar.google.com";

/** Cards with hard-coded billing rules below. Any other card id — including the
 *  CUSTOM_<timestamp> ids the web app generates — can still be saved and totalled,
 *  it just has no server-side statement period. */
const BILLING_CARDS = ["UB", "EW", "RCBC"];


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
    const card = normalizeCard(params.card);
    const note = String(params.note || "Website").trim();
    const date = parseDateInput(params.date);
    const cardName = String(params.cardName || "").trim();

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

    saveTransaction(amount, card, note, date, cardName);

    return jsonResponse({
      ok: true, amount: amount, card: card, cardName: cardName, date: date
    });
  } catch (error) {
    console.error("doPost failed: " + error.message);
    return jsonResponse({ ok: false, error: error.message });
  }
}

/**
 * Read-only JSON API over the same sheet.
 *
 *   ?action=summary                lifetime total per card
 *   ?action=statement&card=UB      current billing period, its total and entries
 *   ?action=limits                 credit limits and remaining spend allowance
 *
 * A web-app deployment set to "Anyone" makes every transaction readable by anyone
 * holding the URL — the same exposure the published CSV already has. Restrict the
 * deployment, or add a shared secret here, if that matters to you.
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const action = String(params.action || "summary").toLowerCase();

    if (action === "summary") {
      return jsonResponse({ ok: true, totals: getTotalsByCard() });
    }

    if (action === "limits") {
      return jsonResponse({ ok: true, cards: getCreditSummary() });
    }

    if (action === "statement") {
      const card = normalizeCard(params.card);

      if (!card) {
        return jsonResponse({ ok: false, error: "A card is required." });
      }

      if (!isBillingCard(card)) {
        return jsonResponse({
          ok: false,
          error: "No billing period is defined for " + card + "."
        });
      }

      return jsonResponse({ ok: true, statement: getStatement(card) });
    }

    return jsonResponse({
      ok: false,
      error: "Unknown action: " + action,
      actions: ["summary", "statement", "limits"]
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
 * Two requests arriving together can both resolve the same last row, so the write
 * is serialised — without the lock one of them silently overwrites the other.
 */
function saveTransaction(amount, card, note, date, cardName) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    const sheet = getTransactionSheet();
    ensureCardNameColumn(sheet);

    sheet.appendRow([
      new Date(),
      date ? new Date(date) : new Date(),
      Number(amount),
      normalizeCard(card),
      note,
      cardName || normalizeCard(card)
    ]);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Adds the Card Name header the first time a row needs it.
 *
 * Only ever writes F1, and only when it is empty, so a sheet that already has
 * the column — or something else in F — is left alone. Rows saved before this
 * column existed keep an empty cell; there is no name to backfill them with.
 */
function ensureCardNameColumn(sheet) {
  if (sheet.getLastRow() === 0) return;
  if (String(sheet.getRange(1, 6).getValue()).trim() !== "") return;

  sheet.getRange(1, 6).setValue("Card Name");
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
        card: normalizeCard(row[3]),
        note: row[4],
        cardName: row[5] || normalizeCard(row[3])
      };
    });
}


// ============================================================
// TOTALS
// ============================================================

/** Lifetime total per card, keyed by normalised card id. */
function getTotalsByCard() {
  const totals = {};

  readTransactions().forEach(function (entry) {
    if (!entry.card || !Number.isFinite(entry.amount)) return;
    totals[entry.card] = (totals[entry.card] || 0) + entry.amount;
  });

  return totals;
}

/** Total spent inside the card's current billing period. */
function getCurrentStatementTotal(card, referenceDate) {
  const normalizedCard = normalizeCard(card);

  if (!isBillingCard(normalizedCard)) return 0;

  const range = getStatementRange(
    normalizedCard,
    referenceDate || new Date()
  );

  return readTransactions().reduce(function (total, entry) {
    const inPeriod =
      entry.card === normalizedCard &&
      entry.date >= range.start &&
      entry.date <= range.end;

    return inPeriod ? total + entry.amount : total;
  }, 0);
}

/** Current billing period plus its entries, ready to serialise. */
function getStatement(card, referenceDate) {
  const normalizedCard = normalizeCard(card);
  const range = getStatementRange(normalizedCard, referenceDate || new Date());

  const entries = readTransactions().filter(function (entry) {
    return entry.card === normalizedCard &&
      entry.date >= range.start &&
      entry.date <= range.end;
  });

  return {
    card: normalizedCard,
    name: range.name,
    start: toDateKey(range.start),
    end: toDateKey(range.end),
    statement: toDateKey(range.statement),
    due: toDateKey(range.due),
    total: entries.reduce(function (sum, entry) { return sum + entry.amount; }, 0),
    count: entries.length,
    entries: entries.map(function (entry) {
      return {
        date: toDateKey(entry.date),
        amount: entry.amount,
        note: entry.note
      };
    })
  };
}


// ============================================================
// CREDIT LIMITS
// ============================================================

function getCreditLimit(card) {
  const normalizedCard = normalizeCard(card);
  if (!normalizedCard) return null;

  const stored = Number(
    PropertiesService
      .getScriptProperties()
      .getProperty("CREDIT_LIMIT_" + normalizedCard)
  );

  if (Number.isFinite(stored) && stored > 0) return stored;

  // Unknown cards have no default; null keeps that distinguishable from zero and
  // stops it turning into NaN downstream.
  return DEFAULT_CREDIT_LIMITS[normalizedCard] || null;
}

function setCreditLimit(card, amount) {
  const normalizedCard = normalizeCard(card);
  const numericAmount = Number(amount);

  if (!normalizedCard) {
    throw new Error("Invalid card: " + card);
  }

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Credit limit must be greater than zero.");
  }

  PropertiesService
    .getScriptProperties()
    .setProperty("CREDIT_LIMIT_" + normalizedCard, String(numericAmount));
}

/**
 * Spend still allowed this cycle under the self-imposed cap:
 * (limit x AVAILABLE_CREDIT_PERCENT) - spent so far. Goes negative once the cap
 * is passed, which is the useful signal. Null when the card has no known limit.
 */
function getAvailableCredit(card, referenceDate) {
  const creditLimit = getCreditLimit(card);
  if (creditLimit === null) return null;

  return (creditLimit * AVAILABLE_CREDIT_PERCENT) -
    getCurrentStatementTotal(card, referenceDate);
}

function getCreditSummary() {
  return BILLING_CARDS.map(function (card) {
    return {
      card: card,
      creditLimit: getCreditLimit(card),
      spentThisCycle: getCurrentStatementTotal(card),
      availableCredit: getAvailableCredit(card)
    };
  });
}


// ============================================================
// BILLING PERIODS
// ============================================================

function isBillingCard(card) {
  return BILLING_CARDS.indexOf(normalizeCard(card)) !== -1;
}

/**
 * The billing period a date falls in, as {start, end, statement, due, name}.
 *
 *   UnionBank  statement the 10th, moved back off non-business days;
 *              due 17 calendar days later, moved forward.
 *   EastWest   period runs the 22nd to the 21st;
 *              due the 15th of the next month, moved back.
 *   RCBC       statement the 3rd;
 *              due 25 calendar days later, moved forward.
 */
function getStatementRange(card, referenceDate) {
  const normalizedCard = normalizeCard(card);
  const today = referenceDate ? new Date(referenceDate) : new Date();
  const year = today.getFullYear();
  const month = today.getMonth();

  if (normalizedCard === "UB") {
    const current = getUBStatementDate(year, month);

    return today <= endOfDay(current)
      ? buildUBRange(getUBStatementDate(year, month - 1), current)
      : buildUBRange(current, getUBStatementDate(year, month + 1));
  }

  if (normalizedCard === "EW") {
    // Before the 21st the open period started last month; after it, this month.
    const shift = today.getDate() <= 21 ? 0 : 1;

    return buildEWRange(
      new Date(year, month + shift, 21),
      new Date(year, month + shift - 1, 22)
    );
  }

  if (normalizedCard === "RCBC") {
    const current = new Date(year, month, 3);

    return today <= endOfDay(current)
      ? buildRCBCRange(new Date(year, month - 1, 3), current)
      : buildRCBCRange(current, new Date(year, month + 1, 3));
  }

  throw new Error("No billing period defined for card: " + card);
}

function getUBStatementDate(year, month) {
  const date = new Date(year, month, 10);

  while (!isBusinessDay(date)) {
    date.setDate(date.getDate() - 1);
  }

  return startOfDay(date);
}

function buildUBRange(previousStatement, statementDate) {
  return {
    start: startOfDay(addDays(previousStatement, 1)),
    end: endOfDay(statementDate),
    statement: startOfDay(statementDate),
    due: moveToNextBusinessDay(addDays(statementDate, 17)),
    name: "UNIONBANK"
  };
}

function buildEWRange(statementDate, periodStart) {
  const dueDate = new Date(
    statementDate.getFullYear(),
    statementDate.getMonth() + 1,
    15
  );

  return {
    start: startOfDay(periodStart),
    end: endOfDay(statementDate),
    statement: startOfDay(statementDate),
    due: moveToPreviousBusinessDay(dueDate),
    name: "EASTWEST"
  };
}

function buildRCBCRange(previousBillingDate, billingDate) {
  return {
    start: startOfDay(addDays(previousBillingDate, 1)),
    end: endOfDay(billingDate),
    statement: startOfDay(billingDate),
    due: moveToNextBusinessDay(addDays(billingDate, 25)),
    name: "RCBC"
  };
}


// ============================================================
// DATES
// ============================================================

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function startOfDay(date) {
  return new Date(
    date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0
  );
}

function endOfDay(date) {
  return new Date(
    date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999
  );
}

function toDateKey(date) {
  return Utilities.formatDate(
    date, Session.getScriptTimeZone(), "yyyy-MM-dd"
  );
}

function moveToPreviousBusinessDay(date) {
  const result = startOfDay(date);

  while (!isBusinessDay(result)) {
    result.setDate(result.getDate() - 1);
  }

  return result;
}

function moveToNextBusinessDay(date) {
  const result = startOfDay(date);

  while (!isBusinessDay(result)) {
    result.setDate(result.getDate() + 1);
  }

  return result;
}

function isBusinessDay(date) {
  return !isWeekend(date) && !isPublicHoliday(date);
}

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/**
 * Cached for six hours per date. The calendar lookup is a network call and the
 * business-day walkers above hit the same handful of dates repeatedly.
 * A lookup failure is treated as "not a holiday" so a calendar outage degrades
 * to plain weekend handling rather than breaking every date calculation.
 */
function isPublicHoliday(date) {
  const cacheKey = "PH_HOLIDAY_" + toDateKey(date);
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);

  if (cached !== null) return cached === "YES";

  let isHoliday = false;

  try {
    const calendar = CalendarApp.getCalendarById(PH_HOLIDAY_CALENDAR_ID);
    if (calendar) {
      isHoliday = calendar.getEventsForDay(date).length > 0;
    }
  } catch (error) {
    console.warn("Holiday calendar unavailable: " + error.message);
  }

  cache.put(cacheKey, isHoliday ? "YES" : "NO", 21600);

  return isHoliday;
}


// ============================================================
// PARSING
// ============================================================

/** Accepts 1234, "1,234", "₱1,234.50". Returns NaN when it is not a number, so
 *  callers can tell "unparseable" from a genuine zero. */
function parseMoney(value) {
  if (value === null || value === undefined || value === "") return NaN;

  return Number(String(value).replace(/[₱,\s]/g, "").trim());
}

/**
 * The web app sends an <input type="date"> value, "YYYY-MM-DD".
 * new Date("2026-09-25") parses as UTC midnight, which lands on the previous day
 * in any timezone behind UTC, so date-only strings are built as a local date
 * instead. Anything else falls back to Date parsing, and unusable input becomes
 * today rather than an Invalid Date written into the sheet.
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

/**
 * Maps the aliases the web app and spreadsheet use onto canonical ids.
 *
 * Anything unrecognised is passed through uppercased rather than rejected — the
 * web app lets you add your own cards, whose ids look like CUSTOM_1760000000, and
 * previously those failed this check and were dropped by doPost without a trace.
 * Only cards in BILLING_CARDS get a statement period; the rest still save and total.
 */
function normalizeCard(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const aliases = {
    ub: "UB",
    union: "UB",
    unionbank: "UB",
    ew: "EW",
    east: "EW",
    eastwest: "EW",
    rcbc: "RCBC"
  };

  const key = raw.toLowerCase().replace(/\s+/g, "");

  return aliases[key] || raw.toUpperCase();
}

function formatPeso(amount) {
  return "₱" + Number(amount).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}
