# 002 — Stagger the logo choices when the card editor first opens

- **Status**: DONE
- **Commit**: 2e51401
- **Severity**: LOW (missed opportunity, additive, delight-tier)
- **Category**: Missed opportunity / Delight
- **Estimated scope**: 1 file (`index.html`), 1 CSS rule + small edits to 3 functions

## Implementation notes (deviations from the plan as written)

Implemented largely as specified, with two fixes found during verification that the plan didn't anticipate:

1. **Call-order bug**: the plan's own target code called `updateLogoPreview(true)` *before* `revealOverlay(el.cardEditorModal)` inside `openCardEditor()`. Since `revealOverlay` is what clears the modal's `hidden` attribute, building and staggering the tiles first meant the whole `#cardEditorModal` subtree — tiles included — was still `display:none` at the moment the transition was supposed to fire, so it completed with zero visible interpolation (confirmed via Playwright: `getComputedStyle` showed the tiles jumping straight to their settled `opacity:1` on the very first sampled frame). Fixed by reordering `openCardEditor()` so `updateLogoPreview(true)` runs *after* `revealOverlay(el.cardEditorModal)` instead of before it. Re-verified: opacity now interpolates (`0` → `0.22` → `1`) across frames.
2. **Event-listener footgun**: `el.customCardName.addEventListener("input",updateLogoPreview)` passed the function directly as the listener, so the DOM invoked it as `updateLogoPreview(inputEvent)` — the `InputEvent` object is truthy, so it satisfied `animate` and re-triggered the stagger on every keystroke while typing a card name, violating the plan's own frequency gate. Fixed by wrapping it: `el.customCardName.addEventListener("input",()=>updateLogoPreview())`.

Verified via Playwright (`getComputedStyle` opacity sampling across `requestAnimationFrame` frames, plus `reducedMotion:'reduce'` context):
- Opening the card editor stages tiles in with real per-tile transition delays (`0ms, 40ms, 80ms, 120ms, ...`), opacity interpolating smoothly rather than snapping.
- Clicking a different logo tile does **not** re-add `is-entering`/`is-settled` — no re-stagger.
- Typing in the card name field does **not** re-stagger either (this was the event-listener bug above, now fixed).
- Closing and reopening the modal replays the stagger correctly (it's per-open, not one-time-ever).
- Under `prefers-reduced-motion: reduce`, tiles resolve to their correct final state (`opacity:1`, `transform:none`) almost instantly, with no visible stagger — matches the plan's expectation that the existing blanket reduced-motion rule covers this with no additional work.

## Problem

`renderLogoSelector()` rebuilds every tile in the logo-choice grid (`#customLogoSelector`) via `innerHTML=...map(...).join("")`, with all tiles appearing at once. This function runs from two very different situations:

1. When the "Add new card" / "Edit card" modal first opens (via `openCardEditor` → `updateLogoPreview()`) — this is the one legitimate entrance moment, and it's rare (adding/editing a custom card is an occasional setup action, not daily-use behavior).
2. Every time the user clicks a *different* logo tile to select it (via the `customLogoSelector` click handler → `updateLogoPreview()`) — this rebuilds the *entire* grid again just to flip which tile has `aria-pressed="true"`, and can fire many times in one sitting while someone browses logo options.

Current code:

```js
// index.html:1440-1454 — current
function renderLogoSelector(){
  if(!el.customLogoSelector) return;
  const currentIsLibrary=LOGO_LIBRARY.some(item=>item.src===pendingCustomLogo);
  const legacyCurrent=pendingCustomLogo&&!currentIsLibrary
    ? [{name:"Current logo",src:pendingCustomLogo}]
    : [];
  const items=[{name:"Initials",src:""},...legacyCurrent,...LOGO_LIBRARY];
  el.customLogoSelector.innerHTML=items.map(item=>{
    const selected=item.src===pendingCustomLogo;
    const visual=item.src
      ? `<img src="${escapeHtml(item.src)}" alt="" loading="lazy">`
      : `<span class="initials-choice">${escapeHtml(initials(el.customCardName.value||"NEW"))}</span>`;
    return `<button class="logo-option" type="button" data-logo-src="${escapeHtml(item.src)}" aria-pressed="${selected}">${visual}<span>${escapeHtml(item.name)}</span></button>`;
  }).join("");
}

function updateLogoPreview(){
  if(pendingCustomLogo){
    el.customLogoPreview.className="logo-preview";
    el.customLogoPreview.innerHTML=`<img src="${pendingCustomLogo}" alt="">`;
  }else{
    el.customLogoPreview.className="logo-preview custom-card-placeholder";
    el.customLogoPreview.textContent=initials(el.customCardName.value||"NEW");
  }
  renderLogoSelector();
}
```

```js
// index.html:1409 — current, inside openCardEditor(): the modal-open call site
updateDueValueLabel();
updateLogoPreview();
revealOverlay(el.cardEditorModal);
```

```js
// index.html:1806-1811 — current, the logo-tile click handler: the re-render call site
el.customLogoSelector.addEventListener("click",event=>{
  const button=event.target.closest("[data-logo-src]");
  if(!button) return;
  pendingCustomLogo=button.dataset.logoSrc||"";
  updateLogoPreview();
});
```

A stagger applied unconditionally inside `renderLogoSelector()` would replay every time a tile is clicked, which fails the frequency gate (clicking through logo choices within one editing session easily happens several times) — so this plan threads a boolean through both call sites and only staggers on the modal-open path.

## Target

```css
/* target — insert directly after the existing .logo-option rule at index.html:384 */
.logo-option.is-entering{
  opacity:0;
  transform:translateY(6px);
}
.logo-option.is-entering.is-settled{
  opacity:1;
  transform:translateY(0);
  transition:opacity 200ms ease,transform 200ms var(--ease-spring);
}
```

```js
// target — index.html:1440, renderLogoSelector gains an optional "animate" flag
function renderLogoSelector(animate=false){
  if(!el.customLogoSelector) return;
  const currentIsLibrary=LOGO_LIBRARY.some(item=>item.src===pendingCustomLogo);
  const legacyCurrent=pendingCustomLogo&&!currentIsLibrary
    ? [{name:"Current logo",src:pendingCustomLogo}]
    : [];
  const items=[{name:"Initials",src:""},...legacyCurrent,...LOGO_LIBRARY];
  el.customLogoSelector.innerHTML=items.map(item=>{
    const selected=item.src===pendingCustomLogo;
    const visual=item.src
      ? `<img src="${escapeHtml(item.src)}" alt="" loading="lazy">`
      : `<span class="initials-choice">${escapeHtml(initials(el.customCardName.value||"NEW"))}</span>`;
    return `<button class="logo-option" type="button" data-logo-src="${escapeHtml(item.src)}" aria-pressed="${selected}">${visual}<span>${escapeHtml(item.name)}</span></button>`;
  }).join("");
  if(animate){
    const tiles=[...el.customLogoSelector.querySelectorAll(".logo-option")];
    tiles.forEach((tile,i)=>{
      tile.classList.add("is-entering");
      tile.style.transitionDelay=`${Math.min(i,6)*40}ms`;
    });
    void el.customLogoSelector.offsetWidth;
    tiles.forEach(tile=>tile.classList.add("is-settled"));
  }
}

function updateLogoPreview(animate=false){
  if(pendingCustomLogo){
    el.customLogoPreview.className="logo-preview";
    el.customLogoPreview.innerHTML=`<img src="${pendingCustomLogo}" alt="">`;
  }else{
    el.customLogoPreview.className="logo-preview custom-card-placeholder";
    el.customLogoPreview.textContent=initials(el.customCardName.value||"NEW");
  }
  renderLogoSelector(animate);
}
```

```js
// target — index.html:1409, inside openCardEditor(): pass true only here
updateDueValueLabel();
updateLogoPreview(true);
revealOverlay(el.cardEditorModal);
```

The click handler at `index.html:1806-1811` is left calling `updateLogoPreview()` with no argument — `animate` defaults to `false`, so re-renders triggered by selecting a different logo never stagger.

Delay is capped at `Math.min(i,6)*40ms` (240ms max extra delay) so a long logo list doesn't push the last tiles' entrance uncomfortably far out — matches the "keep stagger delays short, 30-80ms between items" guidance; 40ms sits in that band.

## Repo conventions to follow

- `--ease-spring: cubic-bezier(.32,.72,0,1)` is this repo's entrance/settle curve — reuse it for the `is-settled` transition rather than a new curve.
- Follow the same `is-entering` (from-state) / `is-settled` (triggers transition to to-state) two-class split used in plan 001 for `.history-item`, and the same `void element.offsetWidth` force-reflow idiom already established by `revealOverlay()` (`index.html:1360-1365`) to commit the from-state before adding the triggering class.
- Default parameters (`animate=false`) matching this codebase's existing style of optional trailing parameters (e.g. `openCardEditor(cardId=null)`).

## Steps

1. Open `index.html`. Directly after the `.logo-option{...}` rule (currently line 384), insert the two new rules shown in **Target** (`.logo-option.is-entering` and `.logo-option.is-entering.is-settled`).
2. Change `renderLogoSelector()`'s signature (currently line 1440) from `function renderLogoSelector(){` to `function renderLogoSelector(animate=false){`, and add the `if(animate){...}` block shown in **Target** at the end of the function, after the existing `el.customLogoSelector.innerHTML=...` assignment.
3. Change `updateLogoPreview()`'s signature (currently line 1456) from `function updateLogoPreview(){` to `function updateLogoPreview(animate=false){`, and change its existing `renderLogoSelector();` call to `renderLogoSelector(animate);`.
4. In `openCardEditor()` (currently line 1409), change `updateLogoPreview();` to `updateLogoPreview(true);`.
5. Leave the logo-tile click handler (currently lines 1806-1811) unchanged — it keeps calling `updateLogoPreview();` with no argument.

## Boundaries

- Do NOT change the click handler at `index.html:1806-1811` to pass `true` — re-selecting a logo must never re-stagger.
- Do NOT apply the stagger to more than the tiles actually present — the `Math.min(i,6)*40ms` cap is required, not optional, so a long `LOGO_LIBRARY` doesn't create a slow rolling entrance.
- Do NOT change `.logo-option`'s existing base rule (layout, background, border, the existing `transition:` for hover/press) — only add the two new `.is-entering`/`.is-entering.is-settled` rules alongside it.
- Do NOT add the stagger to `.choice` (the payment-card picker in the transaction modal) or `.salary-option` — this plan is scoped to the logo selector only; those are different, more frequently-seen pickers and were not part of the reviewed opportunity.
- If `renderLogoSelector()` or `updateLogoPreview()` no longer match the current-code excerpts above (e.g. the innerHTML-based render has been replaced) since commit `2e51401`, STOP and report instead of guessing where to splice in the new parameter.

## Verification

- **Mechanical**: none applicable (no build step). Confirm no console errors on load.
- **Feel check**:
  1. Click the app menu → "Add new card" (or the edit button on an existing custom card). Confirm the logo tiles **fade and rise into place** (`translateY(6px)` → `0`) with each tile lagging the previous by ~40ms, capped at 6 tiles' worth of delay.
  2. With the modal still open, click a different logo tile. Confirm the grid updates (the newly selected tile shows `aria-pressed="true"`) **with no stagger or animation at all** — this is the frequent re-render path.
  3. Close the modal and reopen it (or open it for a different card). Confirm the stagger plays again — it's gated per modal-open, not a one-time-ever flag.
  4. In DevTools, set Animations panel playback to 10% on a fresh modal-open and confirm the per-tile delays are visibly staggered rather than simultaneous.
  5. Toggle `prefers-reduced-motion` (Rendering panel). This repo's existing blanket rule (`index.html:409-416`, universal `transition-duration:0.01ms!important`) already covers `.logo-option.is-entering.is-settled` automatically — confirm all tiles appear in their correct final state effectively instantly, with no stagger perceptible. No plan-specific reduced-motion work is needed here.
- **Done when**: opening the card editor visibly staggers the logo tiles in; clicking a tile to select it never re-triggers that stagger.
