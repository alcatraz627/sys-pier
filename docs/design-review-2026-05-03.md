# sys-pier Design Review — 2026-05-03

> Three parallel Opus design reviews of the post-M4 dashboard, each with a distinct lens. Synthesized into a single report with author commentary and adoption picks at the bottom.

## Setup

- **Subject**: post-M4 dashboard at `http://localhost:5042/` (screenshot at `~/.claude/image-cache/eec81882-243e-4b3f-9d90-c256307e3a21/2.png`)
- **Reviewers**: 3 parallel `general-purpose` agents on Opus, each with a different lens and a curated list of services to study
- **Lenses**: Information Density · Status Hierarchy · Workflow Speed
- **Output budget per reviewer**: 600 words, 5 services studied, 3 max-coverage areas, 10 adoption ideas, 1 highest-leverage pick

---

## Lens 1 — Information Density & Visualization

**Services studied**: Datadog Host Map · Netdata Cloud · Vercel Dashboard · Linear · Grafana

**Max-coverage areas**:
1. **Unified card skeleton with reserved slots** — fixed grid (status stripe / title / identity / 3 KPI slots / mini-history / actions). Adapters fill slots; absent ones render dim placeholders.
2. **Universal mini-history strip** — sparkline-shaped strip on every card; semantics differ per adapter (cpu vs. cron success/fail dots vs. byte rate vs. token-burn).
3. **Status-driven visual weight** — single health enum drives stripe color, title brightness, card opacity. Idle = 60% opacity; errored = brighter title + red stripe.

**Highest-leverage pick**: **Mandate a uniform stat-strip contract on every adapter** — `{ kpis: [{label, value, tone}, ×3], history: number[] }`. Once data conforms, all CSS-level density tweaks become trivial.

**10 adoption ideas** — best 5:
- Status-tinted 3px left stripe (Vercel) — replaces text badges, frees ~80px horizontal
- Reserved 3-slot KPI row (Linear) — every card has same 3 metric slots
- Universal sparkline (Netdata) — adapters expose `history(): number[]`
- Collapse-by-default action overflow (Linear) — primary action inline, rest behind `⋯`
- Density toggle: cozy / compact / row (Datadog + Linear) — `row` = 32px tall single-line records, fixes the empty-space problem

---

## Lens 2 — Status Hierarchy & Attention Signaling

**Services studied**: PagerDuty · Datadog Watchdog · Vercel (Geist Status Dot) · Sentry · GitHub Status

**Max-coverage areas**:
1. **Severity-weighted layout** — every adapter has a "broken/flapping/scheduled/healthy" notion; reordering + resizing by severity helps all 9 types.
2. **Aggregate top-bar / heat strip** — single global signal solves "load 9.90 looks the same as 0.5".
3. **Time-aware change indicators** — "what bounced since I last looked" is universal across types.

**Highest-leverage pick**: **Bundle three changes** — 2px colored left-rail + severity-weighted auto-sort + sticky red top-bar when anything is errored. Pure CSS + a comparator, ships in an afternoon.

**10 adoption ideas** — best 5:
- Sticky severity banner (PagerDuty) — `3 errored · 1 flapping · jump >`, sticks past scroll
- Severity-weighted auto-sort (PagerDuty) — errored > flapping > high-load > online > scheduled > stopped
- Card size tiers (PagerDuty/Vercel) — errored cards span 2 cols + show last-error excerpt; stopped collapse to 1/3-height ghost row
- Restart-count flapping badge (Sentry "regressed") — `≥3 restarts in 10min` flips status to amber `FLAPPING 4×`
- "Since you left" diff pill (Datadog Watchdog) — localStorage-persisted last-viewed timestamp; changed cards get a blue `CHANGED 12m AGO` pill until clicked
- System-load semantic threshold (Datadog) — top metrics strip turns red bg at load > CPU-count, amber at > 0.7×CPU

---

## Lens 3 — Workflow Speed & Power-User Interaction

**Services studied**: Linear · Raycast · Vercel · Superhuman · GitHub

**Max-coverage areas**:
1. **Per-row focus + Action Panel** — `j/k` focus ring + Cmd+K-on-focused-row gives every adapter keyboard coverage without per-type shortcut design.
2. **Structured filter DSL** — `key:value` syntax replaces name-only filter; gives every adapter free filtering if it surfaces fields.
3. **State persistence + optimistic actions** — URL-encoded view state + optimistic adapter responses kills "lost context" + "800ms unclarity" pair.

**Highest-leverage pick**: **Row-focus + Cmd+K Action Panel + adapter `getCommands()` contract.** Raycast pattern on the existing grid: each adapter declares verbs once, the harness gives them keyboard coverage. Substrate for global palette (idea 3) and bulk verbs (idea 6).

**10 adoption ideas** — best 5:
- Row-focus ring with j/k/h/l (Superhuman) — vim-key cursor on cards; Enter opens detail
- Contextual Action Panel on focused row (Raycast) — adapter-contributed verbs with auto-letter hotkeys
- Global Cmd+K palette (Linear) — `restart sys-pier-backend`, `disable cron daily-report`, `tag add critical to redis`
- Filter DSL (GitHub) — `type:cron status:errored tag:critical name~api`; tab-autocompletes from adapter schemas
- URL-encoded view state (Vercel) — tab/filter/scroll/focus/selection in query params; reload = same view; browser-back = previous filter
- Optimistic state + spinner badge (Linear/Vercel) — row immediately shows pending state on action click; resolves on poll-confirm

---

## Author commentary on the synthesis

`★ Insight ─────────────────────────────────────`
- **All three lenses converge on the same underlying move: extend the M4 adapter contract.** Reviewer 1 wants `kpis[]` and `history(): number[]`. Reviewer 2 wants a `severity` enum (or it can be derived from `statusBucket`). Reviewer 3 wants `getCommands()` for the palette. The adapter contract is the leverage point — every UI improvement either builds on it or works around its absence. M4's instinct (data-shape unity) was correct; the next milestone is "richer contract → UI built on it" rather than "redesign cards in CSS."
- **The reviews are mutually-reinforcing, not redundant.** The status-rail (Lens 2) and the stat-strip (Lens 1) and the row-focus (Lens 3) all want the SAME thing: a card whose layout is reserved-slot, whose color signals state, and whose row index is keyboard-addressable. If you ship the row format right, all three lenses are happy.
- **The 800ms-unclarity problem (Lens 3 #7) is the same as the "FLAPPING badge" problem (Lens 2 #5) and the "since you left" pill (Lens 2 #8) — all three are about TIME-AWARENESS in the UI.** Currently the dashboard is stateless across reloads and time-blind during actions. Adding time-aware UI elements (recent change pill, optimistic action state, last-viewed delta) would fix three problems simultaneously.
- **Reviewers 2 and 3 both name URL-encoded view state as adoption-worthy.** That's a strong signal — it's a small change with multi-lens payoff. localStorage for "last viewed" + URL params for "current filter/tab/focus" together solve "no memory across reloads" without server-side config.
- **No reviewer touched the homepage info empty-space problem head-on** — they all proposed *content* that would fill it (severity banner, system-load gauge, "since you left" pills). The empty space isn't the bug; the dashboard's silence about state-changes is the bug. The space is the canvas waiting for time-aware signals.
`─────────────────────────────────────────────────`

---

## Author's adoption — what I'd actually ship

Three tiers, sized by complexity:

### Tier 1 — Pure CSS / templating, ship in <1 hour each (TOTAL: ~3-4 hours)

These need NO contract changes — they exploit the existing `data-status` attribute and existing `statusBucket` field on items.

| # | Idea | Source | Why pick |
|---|------|--------|----------|
| **1** | **Status-tinted left rail (3px)** | Lens 1 #1 / Lens 2 #3 | All three lenses converge here. Pure CSS via `[data-status]` selector. Highest visual-hierarchy ROI. |
| **2** | **Health-driven opacity** for idle cards | Lens 1 #5 | `data-status="stopped"` → `opacity: 0.6`. Dramatic scannability gain, zero structural change. |
| **3** | **Top-bar severity banner** | Lens 2 #1 | Sticky red bar when any card is errored. Counts errors + has a "jump to" link. Solves "errors don't bubble up." |

### Tier 2 — Small contract additions, ship in 1-3 hours each (TOTAL: ~6-8 hours)

These extend the adapter contract or add small server features. Backward-compatible.

| # | Idea | Source | Effort |
|---|------|--------|--------|
| **4** | **Severity-weighted auto-sort** with a "lock order" toggle | Lens 2 #2 | Comparator on `statusBucket` + a CONFIG flag. Maintains a manual mode. |
| **5** | **Filter DSL** — `type:cron status:errored tag:critical` | Lens 3 #4 | Parse the filter box on every keypress; render chips. Adapters already expose all three fields. |
| **6** | **URL-encoded view state** | Lens 3 #8 | Serialize tab/filter/focus/selection to query params on every change. Restore on load. Browser-back works automatically. |
| **7** | **"Since you left" diff pill** | Lens 2 #8 | localStorage timestamp + diff against current state. New blue pill on changed cards until clicked. |

### Tier 3 — M5 candidate (the big payoff, requires contract change)

This is the convergent direction across all three lenses. Worth a dedicated milestone.

**M5: Adapter contract v2 — KPIs, history, commands.**

```js
{
  // existing M4 contract
  id, cost, schema(), stableId(), health(), list(), detail(), actions, ...,
  
  // M5 additions:
  kpis(item): [{label, value, tone}, {label, value, tone}, {label, value, tone}],
  history(item): number[],          // last N samples for the card sparkline
  getCommands(): Command[],          // for the global Cmd+K palette
}
```

Once those three additions land:
- **Cmd+K palette** (Lens 3 #3) becomes mechanical — iterate `registry.list().flatMap(a => a.getCommands())`
- **Universal sparkline** (Lens 1 #3) becomes a single render path — `<svg>{adapter.history(item).map(...)}</svg>`
- **Reserved 3-slot KPI row** (Lens 1 #2) is just `adapter.kpis(item).map(k => <div>...</div>)`
- **Row-focus + Action Panel** (Lens 3 #1, #2) reuses `getCommands()` for the per-row verb panel
- **Card size tiers** (Lens 2 #4) and **density toggle** (Lens 1 #6) work because layout is now data-driven, not hand-coded per type

M5 is roughly a 1-2 day refactor to extend each of the 9 adapters with these three methods, plus the UI work to consume them. Smaller than M4, builds directly on M4's foundation.

### What I'd NOT pick (and why)

- **Datadog-style heatmap of 90-day uptime per card** (Lens 2 #6) — sys-pier doesn't persist history that far back, and adding the storage is a bigger ask than the visual payoff justifies for a single-user tool.
- **Bulk multi-select with Shift+x range** (Lens 3 #5, #6) — single-user with 11 procs. Group operations exist for the genuinely-need-bulk case (`g` key). Not worth the model complexity.
- **Optimistic action UI** (Lens 3 #7) — the existing card-status fix from session 1 (commit `0861526`) already swaps the whole card on status change after the action's 800ms refresh. The remaining unclarity window is small enough to live with for now.
- **Anomaly glyph** (Lens 2 #10) — requires baselining + persistent metrics, which is M5+M5+M5 territory.

---

## Recommendation

Ship Tier 1 (3 ideas) and Tier 2 idea #6 (URL state) in one focused session — call it **post-M4 polish**. That's ~5-6 hours of work that addresses 4 of the 7 most-cited frustrations (no hierarchy, errors don't bubble, equal weight regardless of state, no remember-last-view). Defer Tier 2 ideas #4, #5, #7 to a second session unless one becomes urgent.

**M5 — adapter contract v2** is the natural follow-up if/when the visual polish proves insufficient. It's the ONLY thing all three reviewers separately recommended; that's the strongest signal in this report.

---

## Sources (de-duplicated across reviewers)

- Datadog: [Host Map](https://www.datadoghq.com/blog/datadog-host-map/) · [Dashboards](https://docs.datadoghq.com/dashboards/) · [Watchdog Alerts](https://docs.datadoghq.com/watchdog/alerts/)
- Vercel: [Dashboard Redesign](https://vercel.com/blog/dashboard-redesign) · [Geist Status Dot](https://vercel.com/geist/status-dot) · [Command Menu](https://vercel.com/docs/concepts/dashboard-features/command-menu)
- Linear: [Board Layout](https://linear.app/docs/board-layout) · [Keyboard Shortcuts](https://keycombiner.com/collections/linear/)
- Raycast: [Action Panel](https://manual.raycast.com/action-panel)
- Netdata: [Charts 2.0](https://www.netdata.cloud/blog/all-new-netdata-cloud-charts-2-0/)
- Grafana: [Repeat Panels](https://grafana.com/blog/2020/06/09/learn-grafana-how-to-automatically-repeat-rows-and-panels-in-dynamic-dashboards/)
- PagerDuty: [Incident Priority](https://support.pagerduty.com/main/docs/incident-priority)
- Sentry: [Issue States](https://docs.sentry.io/product/issues/states-triage/)
- GitHub: [New Status Site](https://github.blog/engineering/infrastructure/introducing-the-new-github-status-site/) · [Command Palette](https://docs.github.com/en/get-started/accessibility/github-command-palette)
- Superhuman: [Shortcuts](https://help.superhuman.com/hc/en-us/articles/45191759067411-Speed-Up-With-Shortcuts)
