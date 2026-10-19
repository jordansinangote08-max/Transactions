// Smart Card Advisor for Scriptable. Run once in the app to configure.
// Tokens belong only in Keychain, never in this source or widget parameters.
const key = `card-advisor:${Script.name()}:v1`;
const fm = FileManager.local();
const dir = fm.joinPath(fm.libraryDirectory(), `card-advisor-${Script.name().replace(/[^a-z0-9-]/gi, '_')}`);
const snapshot = fm.joinPath(dir, 'recommendation.json');
if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
function clearCache() {
  if (fm.fileExists(dir)) fm.remove(dir);
  fm.createDirectory(dir, true);
}
function validateSettings(s) {
  if (!s || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(s.endpoint) ||
      !/^https:\/\/[a-z0-9.-]+(?::443)?(?:\/[^\s?#@]*)?$/i.test(s.site) ||
      typeof s.token !== 'string' || s.token.length < 32 || s.token.length > 512) throw new Error('Invalid setup');
  return s;
}
function loadSettings() {
  try { return validateSettings(JSON.parse(Keychain.get(key))); } catch (_) { return null; }
}
async function configure() {
  const old = loadSettings();
  const alert = new Alert();
  alert.title = 'Connect Card Advisor';
  alert.message = 'Enter your existing website, Apps Script /exec URL, and separate read-only widget token. The token stays in this iPhone’s Keychain.';
  alert.addTextField('Existing website HTTPS URL', old ? old.site : '');
  alert.addTextField('Google Apps Script /exec URL', old ? old.endpoint : '');
  alert.addSecureTextField('WIDGET_READ_TOKEN', old ? old.token : '');
  alert.addAction('Save'); alert.addCancelAction('Cancel');
  if (await alert.presentAlert() < 0) return old;
  const s = validateSettings({site:alert.textFieldValue(0).trim(), endpoint:alert.textFieldValue(1).trim(), token:alert.textFieldValue(2).trim()});
  Keychain.set(key, JSON.stringify(s));
  clearCache(); // Never mix data between sites/accounts.
  return s;
}
function validateCard(card) {
  if (card === null) return null;
  if (!card || typeof card.name !== 'string' || !card.name.trim() || card.name.length > 160 || /\d(?:[ -]*\d){11,}/.test(card.name) ||
      typeof card.last4 !== 'string' || !/^(?:\d{4})?$/.test(card.last4) ||
      typeof card.logo !== 'string' || !/^(?:[a-z0-9-]+\.(?:png|svg))?$/.test(card.logo)) throw new Error('Invalid recommendation');
  return {name:card.name, logo:card.logo, last4:card.last4};
}
// The card plus when it was fetched and whether this run reached the backend.
let fetched = {at: null, offline: false};
function readSnapshot() {
  try {
    const saved = JSON.parse(fm.readString(snapshot));
    const card = validateCard(saved.card);
    fetched = {at: Number(saved.at) || null, offline: true};
    return card;
  } catch (_) { return null; }
}
async function getRecommendation(s) {
  try {
    const r = new Request(s.endpoint);
    r.method = 'POST'; r.headers = {'Content-Type':'application/x-www-form-urlencoded'};
    r.body = `action=widget&widgetToken=${encodeURIComponent(s.token)}`;
    r.timeoutInterval = 10;
    const data = await r.loadJSON();
    // Apps Script uses HTTP 200 for application errors: inspect the JSON code.
    if (data && data.ok === false && data.code === 401) { clearCache(); return null; }
    if (!data || data.ok !== true || (r.response && r.response.statusCode !== 200)) throw new Error('Unavailable');
    const card = validateCard(data.card);
    fetched = {at: Date.now(), offline: false};
    fm.writeString(snapshot, JSON.stringify({card, at: fetched.at})); // Explicit null replaces old data.
    return card;
  } catch (_) { return readSnapshot(); } // Offline/temporary failure only; never invent data.
}
function assetBase(site) {
  if (site.endsWith('/')) return site;
  return /\/[^/]+\.html?$/i.test(site) ? site.slice(0, site.lastIndexOf('/') + 1) : `${site}/`;
}
async function getLogo(card, s) {
  if (!card || !card.logo) return null;
  const path = fm.joinPath(dir, card.logo.replace(/\.svg$/, '.png'));
  try { if (fm.fileExists(path)) return fm.readImage(path); } catch (_) {}
  try {
    // Native Scriptable Image cannot decode SVG; use committed rasterizations
    // of those exact existing assets. Original PNG assets are used directly.
    const relative = card.logo.endsWith('.svg') ? `widget-logos/${card.logo.replace(/\.svg$/, '.png')}` : card.logo;
    const r = new Request(assetBase(s.site) + relative); r.timeoutInterval = 8;
    const image = await r.loadImage();
    if (r.response && r.response.statusCode !== 200) return null;
    fm.writeImage(path, image); return image;
  } catch (_) { return null; }
}
function addLogo(parent, image, width, height, centered) {
  if (!image) return;
  const row = parent.addStack(); row.layoutHorizontally();
  if (centered) row.addSpacer();
  const tile = row.addStack(); tile.size = new Size(width, height);
  tile.backgroundColor = new Color('ffffff'); tile.cornerRadius = 12;
  tile.setPadding(8,8,8,8); tile.centerAlignContent();
  const mark = tile.addImage(image); mark.imageSize = new Size(width-16,height-16);
  mark.applyFittingContentMode();
  if (centered) row.addSpacer();
}
function addName(parent, card, size, centered) {
  const text = parent.addText(card.name); text.font = Font.semiboldSystemFont(size);
  text.textColor = Color.dynamic(new Color('28251d'),new Color('d3d2cf'));
  text.lineLimit = 2; text.minimumScaleFactor = 0.65;
  if (centered) text.centerAlignText();
  if (card.last4) {
    parent.addSpacer(5);
    const digits = parent.addText(`•••• ${card.last4}`); digits.font = Font.mediumSystemFont(14);
    digits.textColor = Color.dynamic(new Color('6e6c67'),new Color('aaa9a5'));
    digits.lineLimit = 1; if (centered) digits.centerAlignText();
  }
}
// Ask iOS for a refresh in 5 minutes, and right after 12:00 AM Manila (UTC+8)
// when the new day's card is picked. iOS still decides when it actually runs.
function nextRefresh() {
  const day = 86400000, manila = 8*3600000, now = Date.now();
  const midnight = now - ((now + manila) % day) + day + 60*1000;
  return new Date(Math.min(now + 5*60*1000, midnight));
}
function addUpdated(parent, centered) {
  if (!fetched.at) return;
  const time = new Date(fetched.at).toLocaleTimeString('en-PH', {hour:'numeric', minute:'2-digit', timeZone:'Asia/Manila'});
  parent.addSpacer(6);
  const line = parent.addText(`${fetched.offline ? 'Offline' : 'Updated'} · ${time}`);
  line.font = Font.mediumSystemFont(10);
  line.textColor = Color.dynamic(new Color('8a8780'),new Color('8f8e8a'));
  line.lineLimit = 1; line.minimumScaleFactor = 0.8;
  if (centered) line.centerAlignText();
}
function buildWidget(card, image, s, family) {
  const w = new ListWidget();
  w.backgroundColor = Color.dynamic(new Color('f7f6f2'),new Color('1c1c1b'));
  w.setPadding(16,16,16,16);
  w.refreshAfterDate = nextRefresh();
  if (s) w.url = s.site+'#overview';
  w.addSpacer();
  if (!card) {
    const empty = w.addText('No Recommended Card'); empty.font = Font.mediumSystemFont(16);
    empty.textColor = Color.dynamic(new Color('6e6c67'),new Color('aaa9a5'));
    empty.centerAlignText(); empty.lineLimit = 2; empty.minimumScaleFactor = 0.8;
  } else if (family === 'medium') {
    const row = w.addStack(); row.layoutHorizontally(); row.centerAlignContent();
    addLogo(row,image,88,76,false); if (image) row.addSpacer(18);
    const text = row.addStack(); text.layoutVertically(); addName(text,card,20,false); addUpdated(text,false);
    row.addSpacer();
  } else {
    const large = family === 'large';
    addLogo(w,image,large?120:64,large?92:44,true);
    if (image) w.addSpacer(large?22:10);
    addName(w,card,large?25:16,true);
    addUpdated(w,true);
  }
  w.addSpacer(); return w;
}
async function main() {
  let s = loadSettings(), family = config.widgetFamily || 'small';
  if (!config.runsInWidget) {
    if (!s) s = await configure(); if (!s) return;
    const menu = new Alert(); menu.title = 'Recommended Card';
    menu.message = 'Preview a size, reconnect, or clear this device’s cached recommendation.';
    for (const label of ['Small','Medium','Large','Reconnect','Clear cache','Disconnect']) menu.addAction(label);
    menu.addCancelAction('Cancel'); const action = await menu.presentSheet();
    if (action < 0) return;
    if (action === 5) { Keychain.remove(key); clearCache(); return; }
    if (action === 4) { clearCache(); return; }
    if (action === 3) { await configure(); return; }
    family = ['small','medium','large'][action];
  }
  const card = s ? await getRecommendation(s) : null;
  const image = s ? await getLogo(card,s) : null;
  const w = buildWidget(card,image,s,family);
  if (config.runsInWidget) Script.setWidget(w);
  else if (family === 'medium') await w.presentMedium();
  else if (family === 'large') await w.presentLarge();
  else await w.presentSmall();
}
try { await main(); }
catch (_) {
  if (config.runsInWidget) Script.setWidget(buildWidget(null,null,loadSettings(),config.widgetFamily||'small'));
  else {
    const alert = new Alert(); alert.title = 'Check widget setup';
    alert.message = 'Use your existing HTTPS website URL, Google Apps Script /exec URL without query parameters, and a separate WIDGET_READ_TOKEN of 32–512 characters. Check the installation guide, then run again.';
    alert.addAction('OK'); await alert.presentAlert();
  }
}
Script.complete();
