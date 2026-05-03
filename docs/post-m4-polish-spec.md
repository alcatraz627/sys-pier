# Post-M4 Polish: CSS-only Spec

> Three Tier-1 CSS-only changes from the 2026-05-03 design review.
> Goal: ship visible polish without contract changes, A/B verifiable
> via screenshot.

## Pre-flight: principles invoked

| Principle | Source | What it means here |
| --------- | ------ | ------------------ |
| **Pre-attentive processing** | Treisman 1985 | Color, position, size processed in ~200ms BEFORE conscious attention. Promote signals (status, severity) into pre-attentive channels. |
| **Visibility of system status** | Nielsen heuristic #1 | "The system should always keep users informed about what is going on, through appropriate feedback within reasonable time." |
| **Visual hierarchy** | Tog / Wickens (selective attention) | Designers must actively guide attention. Important = bright/saturated/large. Less important = dim/desaturated/small. |
| **Tufte's data-ink ratio** | Tufte 1983 | Maximize signal per pixel. A 3px stripe encoding 4 health states uses fewer pixels than a 60px badge AND scales as the card grows. |
| **Gestalt: common region** | Wertheimer 1923 | A status stripe that runs the full card height binds the entire card to the status, not just the header where the badge currently lives. |
| **Persistent affordance** | Norman 1988 (signifiers) | When something requires attention, the affordance announcing it should be persistent across scroll, not buried in a feed. |
| **Conservation of attention** | Krug "Don't Make Me Think" | The loudest UI element should be the one warranted least often — that's how the user trusts it when it does fire. |
| **Small multiples** | Tufte 1990 | Heterogeneous resources should look identically-shaped EXCEPT where real data differs. Reduces cognitive load when scanning. |

---

## Change 1 — Status-tinted left rail (3px)

### Goal

Every card gets a 3px colored stripe along its left edge whose color encodes the card's health/status. Healthy = green; idle/scheduled = gray; warning (high restarts, etc) = amber; errored = red.

### User-visible outcome

Eye lands on errored cards in <500ms via peripheral vision, before consciously reading any text. Healthy cards become a "background" the user doesn't have to scan. The status-dot + ALL-CAPS badge become redundant.

### Why this is the right change

- **Today's failure**: status is communicated via two tiny artifacts (a 6px green dot + an ALL-CAPS badge in the card header). Both require central foveal vision to read. A user scanning 11 cards in a grid for "what's broken" has to fixate on each card's header sequentially. Cost: O(N) eye fixations.
- **After the change**: a single peripheral-vision sweep across the grid identifies any non-healthy card in O(1) — one fixation total. Pre-attentive color processing handles it.

### Principles invoked

- **Pre-attentive processing** (color is the canonical pre-attentive feature)
- **Tufte data-ink ratio** (3px × card-height encodes more signal than a 60px badge × header-height)
- **Gestalt common region** (full-height stripe makes the status apply to the whole card visually, not just the badge)
- **Visibility of system status** (Nielsen #1)

### Concrete CSS

```css
/* Left rail: 3px wide, full card height, status-driven color */
.card { position: relative; }
.card::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;          /* top:0 right:auto bottom:0 left:0 */
  width: 3px;
  background: var(--rail-idle, var(--text-faint));
  border-radius: var(--radius-sm) 0 0 var(--radius-sm);
}
.card[data-status="online"]::before    { background: var(--green); }
.card[data-status="errored"]::before   { background: var(--danger); }
.card[data-status="stopped"]::before   { background: var(--text-faint); }
.card[data-status="scheduled"]::before { background: var(--accent); }
.card[data-status="launching"]::before { background: var(--warn, var(--accent)); }
/* idle / inactive / unknown fall through to the default */
```

### Verification

- ✓ Every card has a visible 3px stripe on its left edge
- ✓ Online cards show green, stopped show faint-gray, errored show red, scheduled show accent
- ✓ Stripe extends full card height (not just header)
- ✓ Stripe is visually consistent across pm2 / cron / launchd / daemon / static / merge / port / claude / nginx (the 9 types)

---

## Change 2 — Health-driven opacity for idle cards

### Goal

Cards that aren't actively interesting (`status = "stopped"` or `"inactive"`) drop to ~60% opacity. Active cards stay at 100%.

### User-visible outcome

When the dashboard has 11 cards but only 4 are running, the 4 running cards visually dominate the grid. The 7 stopped cards become a quiet background. The user's eye is naturally guided to the active ones without the dashboard explicitly hiding anything.

### Why this is the right change

- **Today's failure**: a daemon you stopped 3 weeks ago competes for visual real estate with your active dev server. Equal weight regardless of activity. Cognitive cost: the user must read each card's status to know whether it matters.
- **After the change**: visual weight tracks current relevance. Stopped cards are still visible and clickable, but they fade into the background. The user's eye lands on the active cards without effort.

### Principles invoked

- **Visual hierarchy** (Tog / Wickens) — opacity is the simplest hierarchy signal
- **Tog's "reduce visual noise"** — dim what's not needed without hiding it
- **Small multiples** (Tufte) — all cards same shape, opacity is the difference that signals state

### Concrete CSS

```css
/* Stopped/inactive cards fade. Hover restores full opacity (interactivity hint). */
.card[data-status="stopped"],
.card[data-status="inactive"] {
  opacity: 0.55;
  transition: opacity 120ms ease-out;
}
.card[data-status="stopped"]:hover,
.card[data-status="inactive"]:hover,
.card[data-status="stopped"]:focus-within,
.card[data-status="inactive"]:focus-within {
  opacity: 1;
}
```

### Why hover restores opacity

Without it, dimmed cards feel "broken" — clicking a button on a faded card is awkward. Restoring on hover signals "you can still interact with this" while leaving it dim during scan. This matches the **Norman signifier** principle — opacity says "background", hover restoring says "still interactive."

### Verification

- ✓ Stopped cards visibly dimmer than online ones
- ✓ Hovering a stopped card restores it to full opacity smoothly
- ✓ Buttons inside dimmed cards are still clickable (not pointer-events:none)
- ✓ The transition is quick enough to feel responsive (120ms)

---

## Change 3 — Sticky severity banner

### Goal

A persistent top-of-page banner that appears ONLY when one or more cards are errored. Shows: error count, the affected card names (truncated), and a "jump to" link.

### User-visible outcome

If a process crashes while the user is scrolled mid-page, a red bar appears at the top edge of the viewport. The user notices without needing to scroll back up. Clicking the banner scrolls to the first errored card. When the error is resolved, the banner disappears.

### Why this is the right change

- **Today's failure**: errors are discoverable only by scrolling and reading each card's status. With 11 cards, an errored process at row 9 is invisible if you haven't scrolled there. The system is "silent" about partial failure.
- **After the change**: the system actively announces failure. The banner is the **persistent affordance** that survives scrolling. When clicked, it navigates the user to the problem.

### Principles invoked

- **Visibility of system status** (Nielsen #1) — the system must keep users informed
- **Persistent affordance** (Norman) — the announcement survives scroll
- **Conservation of attention** (Krug) — the banner is silent unless something matters; that's how it earns trust when it does fire
- **Provide closure** (Norman) — banner disappears when errors resolve, signaling "everything is fine"

### Concrete HTML + CSS + JS

```html
<!-- Inserted just below the top metrics strip, before the tabs -->
<div id="severity-banner" class="severity-banner" hidden>
  <span class="severity-banner-icon">⚠</span>
  <span class="severity-banner-text"></span>
  <button class="severity-banner-jump">Jump →</button>
</div>
```

```css
.severity-banner {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--danger);
  color: #fff;
  padding: 6px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.78rem;
  font-weight: 600;
  border-radius: var(--radius-sm);
  margin-bottom: 6px;
  animation: severity-banner-in 200ms ease-out;
}
.severity-banner[hidden] { display: none; }
.severity-banner-icon { font-size: 1rem; }
.severity-banner-text { flex: 1; }
.severity-banner-jump {
  background: rgba(255,255,255,0.2);
  border: 1px solid rgba(255,255,255,0.4);
  color: #fff;
  padding: 2px 8px;
  border-radius: 3px;
  cursor: pointer;
  font: inherit;
}
.severity-banner-jump:hover { background: rgba(255,255,255,0.3); }
@keyframes severity-banner-in {
  from { transform: translateY(-100%); opacity: 0; }
  to   { transform: translateY(0);     opacity: 1; }
}
```

```js
// Run on each refresh tick after patchCardsInPlace.
function updateSeverityBanner() {
  const errored = [...document.querySelectorAll('.card[data-status="errored"]')];
  const banner = document.getElementById('severity-banner');
  if (!banner) return;
  if (!errored.length) { banner.hidden = true; return; }
  const names = errored.map(c => c.dataset.name).slice(0, 3);
  const more = errored.length > 3 ? ` and ${errored.length - 3} more` : '';
  banner.querySelector('.severity-banner-text').textContent =
    `${errored.length} errored: ${names.join(', ')}${more}`;
  banner.querySelector('.severity-banner-jump').onclick = () =>
    errored[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  banner.hidden = false;
}
```

### Verification

- ✓ With zero errored cards, banner is `hidden` (not visible)
- ✓ Force a card to `data-status="errored"` (via DevTools) → banner appears
- ✓ Banner shows correct error count and first 3 card names
- ✓ Clicking "Jump →" scrolls to the first errored card
- ✓ Removing the errored status → banner disappears
- ✓ Banner sticks to top of viewport when scrolling
- ✓ Slide-in animation runs once per appearance, not on every refresh

---

## Implementation order

1. Change 1 (left rail) — purely additive CSS, no JS, smallest blast radius. Take BEFORE screenshot first.
2. Change 2 (idle opacity) — purely additive CSS. Verify dimmed cards remain interactive.
3. Change 3 (severity banner) — adds HTML element + CSS + JS. Most complex; ship last when changes 1+2 are confirmed.
4. Take AFTER screenshot. Compare.
5. `pm2 restart sys-pier-backend` after merge.

## Out of scope (deferred to a later session)

- The "since you left" diff pill (Tier 2 #7) — needs localStorage state and is separate from pure CSS.
- Severity-weighted auto-sort (Tier 2 #4) — touches the card render order in `patchCardsInPlace`, not pure CSS.
- Filter DSL (Tier 2 #5) — parser + chip rendering, larger surface.
- URL state encoding (Tier 2 #6) — touches multiple JS handlers.
