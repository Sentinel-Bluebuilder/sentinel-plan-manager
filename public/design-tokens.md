# Plan Manager — Design Tokens & Standards

**Created:** 2026-04-23
**Scope:** `public/index.html` — the entire SPA
**Canonical location of tokens:** `public/index.html` — `:root` block (dark) + `html[data-theme="light"]` block

This document is the canonical reference for how the Plan Manager looks and
behaves. Every visual rule below is enforced via CSS variables in
`public/index.html`. If you change a token, change it here — then change it
in the CSS. Do not ship a colour, radius, or spacing value that isn't in this
table.

---

## Plan Manager design tokens

### Font stack

- **UI / display:** `Europa` (Bold 700, loaded as `@font-face` from
  `/fonts/europa-bold.ttf`), fallback `-apple-system → Segoe UI → Roboto →
  sans-serif`.
  - Applied universally via `*, *::before, *::after { font-family: 'Europa'
    ... !important }` at `public/index.html:117`.
  - Headings (`h1`, `h2`, `h3`, `.page-hero-title`) are forced to `Europa`
    700 at line 118. No weight variance; we lean on size + letter-spacing
    for hierarchy.
  - Base body size `14px`, line-height `1.5`.
- **Monospace (addresses, hashes, denoms, code):** `Noto Sans Mono` (loaded
  from jsDelivr CDN, weight 400), fallback `Liberation Mono → Consolas →
  ui-monospace → monospace`.
  - Exposed via `.mono` class and `var(--font-mono)`.
- **Font vars:**
  - `--font-display: 'Europa', -apple-system, 'Segoe UI', Roboto, sans-serif`
  - `--font-serif:   'Europa', -apple-system, 'Segoe UI', sans-serif`
    (alias; we don't currently ship a serif — kept for future variants)
  - `--font-mono:    'Noto Sans Mono', 'Liberation Mono', Consolas,
    ui-monospace, monospace`

**Rule:** one font family for every human-readable string; one for every
machine string. No third family, no Google-sans variety, no icon-font
requirement. We removed Filson Soft on 2026-04-22 — do not reintroduce it.

### Themes

- **Dark (default)** — `:root` block.
- **Light** — opts in via `html[data-theme="light"]` attribute on `<html>`.
  Toggle via the `toggleTheme()` button in the topbar; preference persists
  in `localStorage` and is re-applied on boot before first paint to prevent
  a flash of wrong theme.
- Both themes use the **same variable names.** Only values differ. Every
  new rule MUST reference a var — never a raw colour. This is how we keep
  the themes in sync.
- Before merging a UI change, screenshot both themes. A forgotten var
  renders white-on-white or black-on-black silently.

### Core colour vars

| Var | Dark | Light | Use |
|-----|------|-------|-----|
| `--bg` | `#060608` | `#f6f7fb` | Page background |
| `--bg-base` | `#060608` | `#f6f7fb` | Solid background under glass layers |
| `--bg-card` | `rgba(16,16,20,0.72)` | `rgba(255,255,255,0.92)` | Card surface (glass) |
| `--bg-card-solid` | `#0d0d12` | `#ffffff` | Solid card when glass would be illegible |
| `--bg-card-hover` | `rgba(26,26,34,0.82)` | `#f1f3f9` | Hover state on interactive cards |
| `--bg-input` | `rgba(255,255,255,0.025)` | `rgba(10,14,30,0.04)` | Form inputs, code blocks |
| `--glass-bg` | `rgba(14,14,20,0.82)` | `rgba(255,255,255,0.85)` | Sidebar, topbar, modals |
| `--border` | `rgba(255,255,255,0.06)` | `rgba(10,14,30,0.08)` | Default divider |
| `--border-hover` | `rgba(255,255,255,0.12)` | `rgba(10,14,30,0.16)` | Hover / focus outline |
| `--border-strong` | `rgba(255,255,255,0.18)` | `rgba(10,14,30,0.22)` | Emphasised borders (warnings, selection) |
| `--text` | `#f0f1f5` | `#0d1224` | Primary text |
| `--text-dim` | `#8a8a9a` | `#4a5068` | Secondary text |
| `--text-muted` | `#55556a` | `#8a90a5` | Placeholders, disabled, meta |
| `--accent` | `#1E88E5` | `#1E88E5` | Sentinel blue — primary actions, links |
| `--accent-bright` | `#4aa4ec` | `#1d78cc` | Hover accent |
| `--accent-glow` | `rgba(30,136,229,0.18)` | `rgba(30,136,229,0.12)` | Soft ambient glow behind accent elements |
| `--accent-dim` | `rgba(30,136,229,0.12)` | `rgba(30,136,229,0.08)` | Accent fill on badges / chips |
| `--accent-hover` | `#4aa4ec` | (inherits accent) | Button hover |
| `--green` | `#00c853` | `#00944a` | Success, registered state |
| `--green-bright` | `#00e676` | `#00a656` | Success hover / emphasis |
| `--green-dim` | `rgba(0,200,83,0.14)` | `rgba(0,148,74,0.10)` | Success badge fill |
| `--red` | `#ff1744` | `#d81b3f` | Error, unregistered / destructive |
| `--red-dim` | `rgba(255,23,68,0.12)` | `rgba(216,27,63,0.10)` | Error badge fill, danger callout bg |
| `--yellow` | `#ff9100` | `#d97706` | Warning, low-balance, pending |
| `--yellow-dim` | `rgba(255,145,0,0.14)` | `rgba(217,119,6,0.12)` | Warning badge / callout bg |
| `--purple` | `#b388ff` | (dark-only) | Secondary accent (ambient gradients only) |
| `--purple-dim` | `rgba(179,136,255,0.14)` | (dark-only) | Secondary gradient wash |

**Variant convention:** every semantic colour ships with a `-glow` and/or
`-dim` soft variant for ambient fills (backgrounds behind a badge, glow
under a button, callout surface). Never use a raw `rgba()` inline —
reference the `-dim` variant.

### Radii

| Var | Value | Use |
|-----|-------|-----|
| `--radius-lg` | `16px` | Hero cards, large surfaces |
| `--radius`    | `12px` | Default card / input / button |
| `--radius-sm` | `8px`  | Compact chips, small inputs |
| `--radius-xs` | `4px`  | Tag corners, tight decorative cuts |

### Elevation (shadows)

| Var | Dark | Light | Use |
|-----|------|-------|-----|
| `--shadow-sm` | `0 2px 8px rgba(0,0,0,0.25)` | `0 2px 8px rgba(10,14,30,0.06)` | Resting card |
| `--shadow-md` | `0 8px 24px rgba(0,0,0,0.35)` | `0 8px 24px rgba(10,14,30,0.10)` | Hover, modals |
| `--shadow-lg` | `0 20px 60px rgba(0,0,0,0.55)` | `0 20px 50px rgba(10,14,30,0.14)` | Top-level overlays (import, low-balance) |
| `--shadow-accent` | `0 0 32px rgba(30,136,229,0.22)` | `0 0 28px rgba(30,136,229,0.18)` | Glow under primary CTAs |
| `--shadow-green`  | `0 0 28px rgba(0,200,83,0.22)`  | `0 0 24px rgba(0,148,74,0.16)`  | Glow under success states |

### Layout

- **Shell:** `--sidebar-w: 272px` left sidebar + `--header-h: 84px` topbar.
  (Token values; do not hardcode `240px` / `64px` — these have been
  widened from defaults for the dense Plan Manager nav.)
- **Page padding:** `28px` vertical / `32px` horizontal on `.page`
  containers. Compact pages use `.page-compact` (smaller card padding).
  Homepage uses `.page-home` (wider hero, centered stats row).
- **Background wash:** two radial gradients layered on `body` — Sentinel
  blue in the top-right, purple (dark) / green (light) in the bottom-left.
  Fixed-attached so the wash stays put during scroll.
- **Max content width:** hero title container caps at `1100px`
  (`.page-home .page-hero`). Default `.page` inherits the shell width.

### Primitives

- **`.stat-card` / `.stat-card-enhanced`** — centred label + value pair,
  104px min-height, used in the dashboard stats row (wallet balance, P2P
  spot price, chain-active nodes, provider status). Value uses `20px` /
  `600` weight; label uses `11px` uppercase `500` weight with `0.4px`
  letter-spacing.
- **`.card` / `.card-header` / `.card-body`** — glass surface
  (`--bg-card`), `var(--radius-lg)` corners, `var(--shadow-sm)` at rest.
  Header: 16px/20px padding, `.card-title` at 16px/600. Body: 22px default
  (18px/20px on home, 14px/16px on compact).
- **`.tbl`** — data table primitive. Header row sits in `--bg-input` with
  `11px` uppercase muted label type. Rows separated by `--border`. Never
  use for flex content — grid-template-columns must match header to row.
- **`.chain-badge`** — monospace denom tag (e.g. `udvpn`, `uP2P`). Dim
  background, `--text-muted` text, `var(--radius-xs)` corners.
- **`.chip`** — small rounded pill, mono font, used for metadata
  (deposit amounts, fee-grant periods, short addresses).
- **`.nav-item`** — sidebar row. Inactive: `--text-dim` label. Active: adds
  a 3px left-edge accent bar (`--accent`), promotes label to `--text`, and
  lifts the background to `--accent-dim`. The edge bar is the single
  "you are here" signal — do not also change icon colour.
- **`.callout`** — inline notification inside a page. Variants via
  modifier classes: `.callout-warn` (yellow), `.callout-danger` (red),
  `.callout-info` (accent). Always paired with a `.callout-icon` svg and a
  flexbox row — never `text-align`-centered.
- **`.mono-inline` / `.mono-tag`** — inline monospace spans for CLI
  command names and denom tags; use sparingly.
- **`.loading-state`** — centred spinner + label. Hosted at
  `public/index.html:2146`. Only show when `#app` has no content; never
  wipe a painted page with a spinner (S3 blink rule).
- **`.mobile-gate`** — full-screen desktop-only overlay at viewport
  ≤1024px or coarse pointer. See `Desktop/standards/standards/S3-ux-frontend.md`
  "Mobile Desktop-Gate Rules".

---

## S3 rules baked into Plan Manager

These are the enforced rules. Every PR that touches the SPA must pass this
list before merge.

### Visual consistency

- **CSS variables for ALL colours.** Single source of truth; no raw hex or
  `rgba()` in component CSS. If the value isn't a var, add one to the
  token table above first.
- **Light + dark tested visually.** Screenshot both themes for any UI
  change before merging. A forgotten var renders white-on-white silently.
- **Font: `Europa` everywhere, `Noto Sans Mono` for machine strings.** No
  third family. Do not reintroduce Filson Soft.
- **Overflow visible on indicator bars.** Progress bars, status dots, and
  accent edges render outside their parent on purpose — a clipped glow is
  a bug.

### Layout

- **Flexbox for icon/text alignment.** `text-align: center` does not
  centre mixed content (emoji/svg + text). Use `display: flex;
  align-items: center; gap: Xpx`.
- **Grid header + row columns MUST match.** Data tables define
  `grid-template-columns` once and reuse; mismatched columns put data
  under the wrong headers.
- **Fixed-width wrappers for emoji and flags.** `display: inline-block;
  width: 1.5em; text-align: center` — emoji widths vary by OS.
- **Page-hero titles use `white-space: nowrap` on desktop** and revert to
  `normal` under 1024px (see `public/index.html:923`). Prevents an awkward
  wrap on the homepage line.

### Performance & feel

- **Loading states within 100ms.** Users perceive >100ms of nothing as
  lag. Show a spinner or skeleton immediately; do not wait for data.
- **One paint per navigation.** Don't wipe `#app` with a spinner when the
  current page is painted and readable — show a non-destructive "Updating…"
  badge instead. See S3 "Rendering & Transitions" rules.
- **Skeleton-first for async pages.** `renderDashboard()` paints its
  skeleton immediately with safe fallbacks (`w.balanceDvpn || 0`,
  `!w.provider ?`) and re-renders when `loadWallet()` resolves. Do NOT
  block first paint on an API call.
- **Stale-while-revalidate must diff before re-rendering.** Background
  refreshes that fire `onRefresh(fresh)` unconditionally cause visible
  re-renders when data hasn't changed. Diff first.
- **Cache API responses with TTL.** Node lists, balances, provider info
  all live in `_dataCache` with per-endpoint TTLs.
- **Debounce user input at 300ms.** Filter and search fields never fire
  per-keystroke.

### Language

- **P2P, not DVPN, in user-facing text.** The token is called P2P. DVPN
  is the on-chain denom (`udvpn`). Every label, stat, and callout says
  P2P. `udvpn` only appears as a denom tag in `.chain-badge`.
- **Mono spelling for denoms.** `uP2P` is always mono-formatted and
  lowercase-`u`.
- **Action verbs on buttons.** "Create plan", "Link nodes", "Grant
  subscriber" — not "Submit" or "Go".

### Data integrity

- **All visible state survives restart.** Dashboard values read from
  `my-plans.json` and `nodes-cache.json` on boot; never render "—" where
  disk had data.
- **Append-only for on-chain state files.** `my-plans.json` only grows.
  Never truncate without explicit user confirmation.
- **Don't wipe caches mid-flow.** A failed transaction does not justify
  dropping `nodes-cache.json`.

### Accessibility

- **Every interactive surface is keyboard-reachable.** `data-page`
  elements receive Enter/Space handling via the global listener at
  `public/index.html:3250`.
- **Focus outlines visible in both themes.** Never `outline: none`
  without an alternative focus ring.
- **`aria-hidden` on elements hidden from sighted users** (e.g. decorative
  svg icons, the mobile-gate-obscured SPA).

---

## How to add a new token

1. Add the variable to **both** the `:root` block AND the
   `html[data-theme="light"]` block in `public/index.html`.
2. Add a row to the table above with dark value, light value, and "Use".
3. Reference the variable (never the raw value) in your component CSS.
4. Screenshot both themes before merging.

## How to add a new primitive

1. Check the list above — if an existing primitive covers 80% of the use
   case, extend it with a modifier class instead of creating a new one.
2. Write the primitive so it reads from tokens (not raw values).
3. Add a row to the "Primitives" list above with its class name,
   purpose, and any modifier variants.
4. Test in both themes.

## Cross-references

- `Desktop/standards/standards/S3-ux-frontend.md` — universal UX standard
  across all Sentinel projects. This doc is the Plan Manager-specific
  binding.
- `Desktop/plans/CLAUDE.md` — project mission, focus areas, session
  startup.
- `Desktop/plans/MANIFESTO.md` — why Plan Manager exists.
