# 001 — Animate the entrance of a newly-added transaction in the history list

- **Status**: N/A — target is dead markup, do not implement
- **Commit**: 2e51401
- **Severity**: LOW (missed opportunity, additive)
- **Category**: Missed opportunity / Preventing a jarring change
- **Estimated scope**: 1 file (`index.html`), 1 CSS rule + small edits to 2 functions

## Why this plan is void

Implemented and verified with Playwright, then reverted. `#logs` (the container `renderLogs()` renders into) is `hidden` in the markup (`index.html:529`) and **nothing in the codebase ever clears that attribute** — `el.logs.hidden` is set exactly nowhere. The HTML comment directly above it explains why: `<!-- Transaction history is stored/synced in the background and viewed in Google Sheets. -->`. The home-screen history list — and therefore every `.history-item` this plan targets — is permanently `display:none` and has been since the Google Sheets sync replaced it. It is not reachable by any user action.

A second, now-removed candidate surface doesn't exist either: an earlier billing-statement modal iteration also rendered `.history-item` rows into `#statementList`, but that list was deliberately dropped (see git history: "Simplify billing statement to a summary only, drop the itemized list") in favor of a totals-only summary. There is currently no code path in this app that ever displays a `.history-item` element to a user.

Confirmed via Playwright: the CSS/JS technique specified below (`is-entering`/`is-settled` + forced-reflow) is not at fault — an isolated repro of the identical pattern (fresh element, same two classes, same `void el.offsetWidth`) animates correctly in the same browser. Sampling `getComputedStyle(item).opacity` after calling the real `renderLogs(newId)` showed `opacity` at `1` on the very first frame, with no interpolation — the signature of a transition attempted on an element inside a `display:none` ancestor, which cannot animate regardless of how the classes are toggled.

**Do not re-attempt this plan against `#logs`.** If the history list is ever un-hidden and shown to users again in the future, this plan's CSS/JS (preserved below, unmodified) remains valid and can be applied as originally written — re-verify with the feel-check steps once that's true.

## Problem

`renderLogs()` fully tears down and rebuilds the "Recent transactions" list (`el.logs.innerHTML = ""`, then re-append every item) on every add, edit, and delete. When a user saves a new transaction, it appears at the top of the list (`logs.unshift(...)`) with zero transition — the whole list just teleports into its new state.

Current code:

```js
// index.html:1639-1664 — current
function renderLogs(){
  el.logs.innerHTML = "";
  el.emptyState.hidden = logs.length>0;
  if(!logs.length) return;

  logs.forEach(log=>{
    const item = document.createElement("div");
    item.className = "history-item";
    const cardName = log.cardName || cardDisplayName(log.card);
    const note = log.note || cardName;
    item.innerHTML = `
      <div class="history-main">
        <div class="history-title">${escapeHtml(note)}</div>
        <div class="history-meta">${fmtLong(log.date)} · ₱${Number(log.amount).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2})} · ${cardName}</div>
      </div>
      <div class="history-actions">
        <button class="icon-btn" type="button" data-action="edit" data-id="${log.id}" aria-label="Edit transaction">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <button class="icon-btn danger" type="button" data-action="delete" data-id="${log.id}" aria-label="Delete transaction">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>
        </button>
      </div>`;
    el.logs.appendChild(item);
  });
}
```

```js
// index.html:1712-1733 — current, the transaction-save handler
if(editingId){
  const log = logs.find(item=>item.id===editingId);
  if(log){
    log.amount = amount;
    log.date = date;
    log.card = card;
    log.note = note;
  }
}else{
  logs.unshift({id:Date.now(),amount,date,card,cardName:selectedCardRecord?.name||card,note});
  fetch(WEB_APP_URL,{
    method:"POST",
    mode:"no-cors",
    body:new URLSearchParams({amount:String(amount),card,note:note||card,date})
  }).catch(()=>{});
}

saveLocal();
renderLogs();
closeModal();
resetForm();
```

Because `renderLogs()` takes no argument and always rebuilds every row identically, there is no way today to distinguish "a brand-new row just appeared" from "the whole list re-rendered because something was edited or deleted" — so any entrance animation added naively to every row would replay on every single edit or delete too, which is worse than no animation (constant, meaningless motion on an unrelated row every time you touch the list).

## Target

Thread an optional "this id just appeared" parameter through `renderLogs`, set only on the genuine add path, and animate only that one row using this repo's existing force-reflow-then-toggle-class convention (the same pattern `revealOverlay` already uses for the modals/menu).

```css
/* target — insert directly after the existing .history-item rule at index.html:107 */
.history-item{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);padding:.95rem .35rem;border-bottom:1px solid var(--divider)}
.history-item.is-entering{
  opacity:0;
  transform:translateY(-6px);
  transition:opacity 200ms ease,transform 200ms var(--ease-spring);
}
.history-item.is-entering.is-settled{
  opacity:1;
  transform:translateY(0);
}
```

```js
// target — index.html:1639, renderLogs gains an optional param
function renderLogs(justAddedId=null){
  el.logs.innerHTML = "";
  el.emptyState.hidden = logs.length>0;
  if(!logs.length) return;

  logs.forEach(log=>{
    const item = document.createElement("div");
    item.className = "history-item";
    const cardName = log.cardName || cardDisplayName(log.card);
    const note = log.note || cardName;
    item.innerHTML = `
      <div class="history-main">
        <div class="history-title">${escapeHtml(note)}</div>
        <div class="history-meta">${fmtLong(log.date)} · ₱${Number(log.amount).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2})} · ${cardName}</div>
      </div>
      <div class="history-actions">
        <button class="icon-btn" type="button" data-action="edit" data-id="${log.id}" aria-label="Edit transaction">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <button class="icon-btn danger" type="button" data-action="delete" data-id="${log.id}" aria-label="Delete transaction">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>
        </button>
      </div>`;
    el.logs.appendChild(item);
    if(justAddedId!==null&&String(log.id)===String(justAddedId)){
      item.classList.add("is-entering");
      void item.offsetWidth;
      item.classList.add("is-settled");
    }
  });
}
```

```js
// target — index.html:1712-1733, the save handler passes the new id only on the add path
let newEntryId=null;
if(editingId){
  const log = logs.find(item=>item.id===editingId);
  if(log){
    log.amount = amount;
    log.date = date;
    log.card = card;
    log.note = note;
  }
}else{
  newEntryId=Date.now();
  logs.unshift({id:newEntryId,amount,date,card,cardName:selectedCardRecord?.name||card,note});
  fetch(WEB_APP_URL,{
    method:"POST",
    mode:"no-cors",
    body:new URLSearchParams({amount:String(amount),card,note:note||card,date})
  }).catch(()=>{});
}

saveLocal();
renderLogs(newEntryId);
closeModal();
resetForm();
```

The other three call sites (`index.html:1743` inside the delete handler, `index.html:1752` inside "Clear history", and `index.html:1955` on initial page load) keep calling `renderLogs()` with no argument — `justAddedId` defaults to `null`, so none of those renders animate anything, exactly as today.

## Repo conventions to follow

- `--ease-spring: cubic-bezier(.32,.72,0,1)` (defined in `:root`) is this repo's entrance/settle curve, already used for the modal panel, toast-equivalent surfaces, and every `:active` press transform — reuse it here instead of inventing a new curve.
- The force-reflow-then-toggle-class technique (`element.hidden=false; void element.offsetWidth; element.classList.add("is-visible")`) is already established by `revealOverlay()` (`index.html:1360-1365`) for the exact same reason: a freshly-inserted/unhidden element needs its starting style committed to layout before adding the class that triggers the transition, or the browser collapses the transition to nothing. This plan reuses that same `void element.offsetWidth` idiom rather than introducing `requestAnimationFrame`.
- Keep the two class names separate (`is-entering` sets the *from* state, `is-settled` triggers the transition to the *to* state) rather than a single class, matching how `.modal`/`.mobile-menu`-equivalent overlays in this codebase separate "present in DOM" from "visible" state.

## Steps

1. Open `index.html`. Directly after the `.history-item{...}` rule (currently line 107), insert the two new rules shown in **Target** (`.history-item.is-entering` and `.history-item.is-entering.is-settled`).
2. Change the `renderLogs()` function signature (currently line 1639) from `function renderLogs(){` to `function renderLogs(justAddedId=null){`.
3. Inside the `logs.forEach(...)` loop, immediately after the existing `el.logs.appendChild(item);` line, add the `if(justAddedId!==null&&String(log.id)===String(justAddedId)){...}` block shown in **Target**.
4. In the transaction-save submit handler (currently lines 1712-1733), declare `let newEntryId=null;` immediately before the existing `if(editingId){`. Inside the `else` branch, change `logs.unshift({id:Date.now(),...})` to first assign `newEntryId=Date.now();` then use that variable as the `id` in the pushed object (`logs.unshift({id:newEntryId,amount,date,card,cardName:selectedCardRecord?.name||card,note});`). Change the final `renderLogs();` call in this handler to `renderLogs(newEntryId);`.
5. Do not change the other three `renderLogs()` call sites (delete handler, clear-history handler, initial page-load render) — leave them as bare `renderLogs()` calls.

## Boundaries

- Do NOT add the entrance animation to every row on every render — it must fire only for the single row matching `justAddedId`, only on the genuine add path.
- Do NOT change `.history-item`'s existing layout properties (`display`, `align-items`, `justify-content`, `gap`, `padding`, `border-bottom`) — only add the two new `.is-entering`/`.is-entering.is-settled` rules alongside it.
- Do NOT touch `editLog()`, the delete handler, or "Clear history" — none of them should pass a `justAddedId`.
- Do NOT introduce `requestAnimationFrame` — use the existing `void element.offsetWidth` force-reflow idiom already established by `revealOverlay()` for consistency.
- If `renderLogs()` no longer matches the current-code excerpt above (e.g. it's been refactored to a different rendering approach, or the submit handler no longer builds the object inline with `logs.unshift`) since commit `2e51401`, STOP and report instead of guessing where to splice in the new parameter.

## Verification

- **Mechanical**: none applicable (no build step). Open the app, confirm no console errors on load.
- **Feel check**:
  1. Open the app with at least one existing transaction in history. Add a new transaction. Confirm the new row **fades and slides down into place** from slightly above (`translateY(-6px)` → `0`) over roughly 200ms, while every existing row beneath it does **not** animate — it should just be there.
  2. Edit an existing transaction (not the one you just added). Confirm the list rebuilds with **no animation on any row** — this is a re-render, not an add.
  3. Delete a transaction. Confirm no row animates.
  4. Click "Clear history" and confirm the empty state appears with no animation, then add a new transaction into the now-empty list and confirm that single new row still animates in correctly.
  5. Reload the page with existing history. Confirm the list appears fully instantly on first paint — no row should animate in on page load.
  6. In DevTools, set Animations panel playback to 10% and add a transaction — confirm the entering row's opacity and `translateY` move together smoothly, not stepped.
  7. Toggle `prefers-reduced-motion` (Rendering panel). This repo already has a blanket `@media(prefers-reduced-motion:reduce){ *,*::before,*::after{ transition-duration:0.01ms!important; ... } } }` rule (`index.html:409-416`) — confirm it covers `.history-item.is-entering` automatically (it's a universal selector), so the new row still ends up in its correct final position, just without the animated sweep. No plan-specific reduced-motion work is needed here.
- **Done when**: adding a new transaction visibly animates only that one row in; editing, deleting, clearing, and initial page load never animate any row.
