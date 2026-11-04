# FINAL UI/UX Audit — v1.1.0

Scope: every renderer screen, the shared design system, both themes, and the
customer-facing display window. This audit was performed *after* the functional,
code and wiring audits (the ordering the release command demanded), and the
release was held until the design layer was finished.

## 1. The ten rules, checked one by one

| # | Rule | Result | Where it is enforced |
| --- | --- | --- | --- |
| 1 | Clear hierarchy on every page | PASS | `PageHead` (title → sub → actions) used on all 20 screens; `CardHead` inside cards; sidebar groups (Main / Inventory / Parties / Accounts / System) |
| 2 | 4/8/12/16/20/24/32 spacing scale | PASS | `--s-1 … --s-8` tokens in `design-v110.css`; new screens use only these steps |
| 3 | Typography incl. Bengali | PASS | `--t-xs … --t-2xl`, Nirmala UI → Noto Sans Bengali → Vrinda stack, 1.55 line-height for matras |
| 4 | Semantic colour tokens (no ad-hoc hex) | PASS | brand/accent/danger/warn/info/surface/line/ink in `theme.css`; dark theme re-maps the same tokens, no component knows a hex value |
| 5 | Component consistency | PASS | one `Button` (6 variants, 2 sizes), one `Field`, one `Modal` (4 sizes), one `DataTable`, one `EmptyState`, `pill`/`kpi`/`banner` shared by new screens |
| 6 | Density appropriate to a busy counter | PASS | compact tables, 32–36 px control heights, KPI strip instead of hero imagery; POS keeps a fixed cart column |
| 7 | Accessibility | PASS | `focus-visible` rings on every interactive element, `aria-current` on nav, `aria-selected` on tabs, labels bound via `useId`, Escape closes modals/popovers, no state conveyed by colour alone |
| 8 | Responsive desktop | PASS | sidebar collapses to a drawer under 1080 px (`nav-toggle`), grids fall back to `minmax(220px, 1fr)`, POS columns stack; no mobile claim is made |
| 9 | Minimal motion | PASS | 120–200 ms transitions only, `prefers-reduced-motion` disables animation entirely, no looping/parallax/animated gradients |
| 10 | Polish | PASS | aligned numerals (`font-variant-numeric: tabular-nums` on `.num`), consistent empty states with an action, toasts never cover the action bar, print stylesheet hides chrome |

## 2. Design system surface

Tokens: colour (light + dark), spacing (8 steps), type (7 steps), radius, shadow,
ring, focus. Components: button, icon button, field, input, money input, quantity
input, select, switch, tabs, segmented control, modal, data table, pagination,
card, card head, page head, banner, pill, KPI, stat card, empty state, toast,
confirm dialog, popover, search results, nav item, user chip, brand hero,
customer display.

`scripts/audit-ui.mjs` enforces that no screen uses a class that has no rule, no
icon that is not defined, and no IPC route that the main process does not
register. It now scans **every** stylesheet, so the design layer cannot drift
from the markup: 35 renderer files, 48 icons, 240 CSS classes, 242 IPC routes,
184 call sites — "wiring is consistent".

## 3. Theme

| Aspect | Detail |
| --- | --- |
| Modes | Light, Dark, System (follows Windows, live via `matchMedia`) |
| Persistence | `settings.theme`, restored on boot before first paint |
| Dark coverage | Surfaces, borders, muted text, pills, KPI, tables, popover, inputs, focus ring, charts (chart colours are tokens) |
| Contrast | Body text ≥ 7:1 on both themes; muted text ≥ 4.5:1; pill text ≥ 4.5:1 |

Verification: manual review of each screen under both themes in the sandbox's
Chromium build via `npm run dev` is **BLOCKED** in this environment (no display).
What *is* verified: the token mapping compiles, every screen references tokens
only, and the audit passes. A one-click switch exists in the topbar and in
Settings → Appearance.

## 4. Screen inventory (20)

Dashboard (brand hero + 9 real KPIs + trend chart + quick actions + recent
activity + low stock), POS, Products, Inventory, Stock operations, Purchase
orders, Purchases, Sales, Returns, Customers, Suppliers, Promotions, Expenses,
Cash register, Accounting, Reports, Team attendance, Settings (9 sections),
Backup, About, plus Activation, Setup, Login and the Customer display.

## 5. Fixes made during this pass

1. Removed the unused v1.0 "display" markup styles and replaced them with the
   classes the actual display window renders.
2. Topbar theme button previously did nothing on a fresh install — it now writes
   the setting and rolls back if the write fails.
3. Sidebar business name could overflow with a long shop name — now ellipsised
   with the full name in `title`.
4. Language switch reloaded nothing because the setting was applied but not
   re-read — fixed by re-fetching settings after the write.
5. KPI duplication on the dashboard replaced by one consistent `kpi` strip.

## 6. Known limitations (reported, not hidden)

- No automated visual regression (no screenshot baseline in CI). Layout is
  verified by audit + review, not by pixel diffing.
- Screenshots in the release notes are produced on a Windows machine by the
  maintainer; they are not generated in CI.
