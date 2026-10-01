# Design System — Student / Parent Portal

A reusable design guide extracted from the **Analysis Student Portal** (Angular 15 + Bootstrap 5 + Bootstrap Icons).
Use it as the reference when building or redesigning screens in any similar portal/ERP front-end.

> Stack assumptions: Bootstrap 5 grid & utilities, Bootstrap Icons (`bi bi-*`), Google Fonts **Nunito** (headings) + **Open Sans** (body).
> Everything below is plain CSS, so it ports to React/Vue/plain HTML unchanged.

---

## 1. Principles

1. **Answer "whose data / which year?" first.** Every screen shows the active student (and academic year) near the top. Parents can always switch child without leaving the page.
2. **Action before information.** Things that need doing (fee due, low attendance, pending forms) go at the top as *attention items* with one clear CTA.
3. **One primary action per area.** One filled primary button; everything else is ghost/outline or a text link.
4. **Status by colour + icon + word.** Never colour alone: `✓ Paid`, `⚠ Overdue`, `✕ Not applied`.
5. **Inline feedback, no `alert()` / page reloads.** Validation messages live under the field; server errors in an alert box above the form.
6. **Loading = skeleton, empty = friendly empty state.** Never show a blank card or "undefined".
7. **Mobile first-class.** Tables turn into stacked cards, a bottom tab bar replaces the side menu, tap targets ≥ 44 px.
8. **Design-only changes must not alter bindings.** When restyling, keep every `(click)`, `[ngModel]`, `formControlName`, `*ngIf` condition and route exactly as is.

---

## 2. Design tokens

Paste this at the top of `styles.css` (global) — or scope it on a page wrapper class (e.g. `.db`, `.fd`, `.jd`).

```css
:root {
  /* brand */
  --navy:        #012970;   /* headings, key numbers */
  --primary:     #4154f1;   /* buttons, links, active states */
  --primary-600: #3243d6;   /* primary hover */
  --primary-50:  #eef1ff;   /* primary tint: chips, icon bg, active rows */
  --brand-orange:#ff6a1f;   /* marketing/brand panel only (login) */

  /* text */
  --text:        #2c3a5a;   /* body text */
  --text-strong: #1f2a44;   /* card titles */
  --muted:       #6c7a96;   /* secondary text, labels */
  --faint:       #9aa6bf;   /* icons, placeholders, chevrons */

  /* surfaces & lines */
  --bg:          #f6f9ff;   /* page background */
  --surface:     #ffffff;   /* cards */
  --surface-2:   #f8f9fd;   /* inset panels, fact boxes */
  --line:        #e6eaf3;   /* card borders */
  --line-soft:   #eef1f7;   /* row dividers */

  /* status (fg / bg) */
  --good:  #15803d; --good-bg:  #e7f7ee;
  --warn:  #b86e00; --warn-bg:  #fff3dc;
  --bad:   #c62828; --bad-bg:   #fde8e8;
  --info:  #4154f1; --info-bg:  #eef1ff;

  /* accent set (quick actions, categories) */
  --violet: #7c3aed; --violet-bg: #f2ebff;
  --amber:  #e08a00; --amber-bg:  #fff3dc;
  --teal:   #0d9488; --teal-bg:   #e0f5f2;

  /* radius */
  --r-xs: 6px;  --r-sm: 8px;  --r-md: 10px;  --r-lg: 12px;
  --r-xl: 14px; --r-2xl: 16px; --r-pill: 999px;

  /* shadow (always navy-tinted, never pure black) */
  --sh-1: 0 2px 8px  rgba(1, 41, 112, .04);   /* resting card */
  --sh-2: 0 10px 24px rgba(1, 41, 112, .08);  /* hover */
  --sh-3: 0 20px 50px rgba(1, 41, 112, .10);  /* modal / login shell */
  --ring: 0 0 0 4px rgba(65, 84, 241, .12);   /* focus ring */

  /* motion */
  --t-fast: .15s; --t: .2s;
}
body { background: var(--bg); color: var(--text); font-family: "Open Sans", sans-serif; }
```

### Colour usage rules
| Use | Token |
|---|---|
| Page title, card title, big numbers | `--navy` |
| Buttons, links, active tab, focus | `--primary` |
| Selected/highlighted row, chip, icon tile | `--primary-50` bg + `--primary` fg |
| Labels, captions, "of ₹X" | `--muted` |
| Success / paid / present | `--good` on `--good-bg` |
| Pending / due soon / average | `--warn` on `--warn-bg` |
| Overdue / absent / error | `--bad` on `--bad-bg` |

---

## 3. Typography

| Role | Font | Size / weight | Colour |
|---|---|---|---|
| Page title (`h1`) | Nunito | 24px / 800 (20px on ≤575px) | `--navy` |
| Page subtitle | Open Sans | 14px / 400 | `--muted` |
| Card title (`h2`) | Nunito | 17px / 800, with 17px primary icon, gap 8px | `--navy` |
| Section title (`h3`) | Nunito | 15–15.5px / 800 | `--navy` |
| Body | Open Sans | 14px / 400, line-height 1.55–1.65 | `--text` |
| Label / caption | Open Sans | 11.5–13px / 600–700 | `--muted` |
| Overline (status label) | Open Sans | 11px / 600, UPPERCASE, letter-spacing .04em | `--muted` |
| KPI / amount | Nunito | 19–26px / 800 | `--navy` or status colour |
| Chip / tag | Open Sans | 10.5–12px / 700 | per status |

Money: always `₹` + Indian grouping → `n.toLocaleString('en-IN')` (₹1,18,750). Dates: `dd MMM yyyy` (01 Sep 2026); receipts `dd-MM-yyyy`.

---

## 4. Spacing & layout

- Base unit **4px**. Common gaps: 6, 8, 10, 12, 14, 16, 18, 20.
- Card padding **18px** (15–16px on mobile). Page section gap **18px**.
- Grids use CSS Grid, not fixed Bootstrap cols, so cards always fill 100% width:

```css
/* equal columns for however many tiles exist (KPIs) */
.kpis { display:grid; grid-auto-flow:column; grid-auto-columns:minmax(0,1fr); gap:16px; }
@media (max-width:1199px){
  .kpis { grid-auto-flow:row; grid-template-columns:repeat(2,minmax(0,1fr)); }
  .kpis > :last-child:nth-child(odd) { grid-column:1 / -1; }   /* odd one spans */
}

/* fluid tiles that stretch to fill the row */
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; }

/* fixed "3 per row on PC" listing (e.g. job drives) */
.cards-3 { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:20px; }
@media (max-width:991px){ .cards-3 { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:575px){ .cards-3 { grid-template-columns:1fr; gap:14px; } }
```

### Breakpoints (Bootstrap)
| Name | Width | Behaviour |
|---|---|---|
| xs | < 576 | single column, full-bleed login, stacked buttons |
| sm/md | 576–991 | 2-column grids |
| lg | 992–1199 | side menu hidden → **bottom tab bar** |
| xl | ≥ 1200 | side menu visible, full grids |

On < 1200px reserve space for the tab bar:
```css
@media (max-width:1199px){ #main { padding-bottom: calc(84px + env(safe-area-inset-bottom)) !important; } }
```

---

## 5. Components

Naming: each page gets a 2-letter prefix (`db-` dashboard, `fd-` fees, `jd-` drives, `rc-` receipt, `lg-` login, `pv-` preview, `sf-` student form). Modifiers use `--` (`.jd-btn--primary`), states use `is-` (`.is-paid`, `.is-invalid`).

### 5.1 Page header
```html
<div class="pg-head">
  <div>
    <h1 class="pg-title">Placement Drives</h1>
    <p class="pg-sub">2 drives available for you</p>
  </div>
  <a class="btn pg-btn pg-btn--ghost" href="#/student/dashboard"><i class="bi bi-arrow-left"></i> Back</a>
</div>
```
```css
.pg-head { display:flex; flex-wrap:wrap; align-items:flex-end; justify-content:space-between; gap:8px 16px; margin-bottom:18px; }
.pg-title { margin:0; font-family:"Nunito",sans-serif; font-size:24px; font-weight:800; color:var(--navy); }
.pg-sub { margin:4px 0 0; font-size:14px; color:var(--muted); }
```

### 5.2 Card
```css
.card-x { background:var(--surface); border:1px solid var(--line); border-radius:var(--r-xl);
          box-shadow:var(--sh-1); padding:18px; }
.card-x-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:14px; }
.card-x-head h2 { margin:0; display:flex; align-items:center; gap:8px; font:800 17px "Nunito",sans-serif; color:var(--navy); }
.card-x-head h2 i { color:var(--primary); }
/* clickable card */
.card-x.is-link { cursor:pointer; transition:transform var(--t-fast), box-shadow var(--t-fast), border-color var(--t-fast); }
.card-x.is-link:hover { transform:translateY(-2px); box-shadow:var(--sh-2); border-color:var(--primary); }
```
Card header right side = a count chip (`2 receipts`) or a muted hint.

### 5.3 KPI tile
Icon tile (tint bg) + label + big value + status word + thin progress bar.
```css
.kpi { --c:var(--primary); --tint:var(--primary-50);
  display:flex; flex-direction:column; padding:16px 18px 14px; background:#fff;
  border:1px solid var(--line); border-radius:var(--r-xl); box-shadow:var(--sh-1); cursor:pointer; }
.kpi:hover { transform:translateY(-2px); border-color:var(--c); box-shadow:0 12px 26px rgba(1,41,112,.10); }
.kpi-icon { width:40px; height:40px; border-radius:var(--r-lg); background:var(--tint); color:var(--c);
  display:flex; align-items:center; justify-content:center; font-size:19px; }
.kpi-value { font:800 26px "Nunito",sans-serif; color:var(--navy); }
.kpi-bar { height:6px; border-radius:6px; background:var(--line-soft); overflow:hidden; }
.kpi-bar > span { display:block; height:100%; background:var(--c); }
```
Status thresholds (attendance/marks): **Good ≥ good**, **Average ≥ mid**, else **Needs focus** → `st-good / st-warn / st-bad`.

### 5.4 Attention item (action banner)
Tone = `info | warn | danger`. Icon + title + one-line text + one CTA button. On mobile shows first 2, then "Show all".
```css
.attn { display:flex; align-items:center; gap:12px; padding:12px 14px; border-radius:var(--r-lg);
        border:1px solid var(--line); background:#fff; }
.attn--warn   { background:var(--warn-bg); border-color:#ffe3a3; }
.attn--danger { background:var(--bad-bg);  border-color:#f8c9c9; }
.attn--info   { background:var(--info-bg); border-color:#d6dcff; }
```

### 5.5 Quick-action tile
Left colour stripe + tinted icon + title + tag + CTA text. Colour via modifier.
```css
.qa { --c:var(--primary); --tint:var(--primary-50); position:relative; display:flex; gap:14px; padding:16px;
      background:#fff; border:1px solid var(--line); border-radius:var(--r-xl); overflow:hidden; text-align:left; }
.qa::before { content:""; position:absolute; inset:0 auto 0 0; width:4px; background:var(--c); }
.qa:hover { border-color:var(--c); box-shadow:var(--sh-2); transform:translateY(-2px); }
.qa--violet{--c:var(--violet);--tint:var(--violet-bg)} .qa--amber{--c:var(--amber);--tint:var(--amber-bg)}
.qa--teal{--c:var(--teal);--tint:var(--teal-bg)}       .qa--blue{--c:var(--primary);--tint:var(--primary-50)}
.qa-icon { flex:0 0 44px; height:44px; border-radius:var(--r-lg); background:var(--tint); color:var(--c);
           display:flex; align-items:center; justify-content:center; font-size:20px; }
```

### 5.6 Chips, tags, pills
```css
.chip { display:inline-flex; align-items:center; gap:5px; padding:3px 10px; border-radius:var(--r-pill);
        font-size:12px; font-weight:700; background:var(--primary-50); color:var(--primary); }
.chip--good { background:var(--good-bg); color:var(--good); }
.chip--warn { background:var(--warn-bg); color:var(--warn); }
.chip--bad  { background:var(--bad-bg);  color:var(--bad); }
.chip--solid{ background:var(--primary); color:#fff; font-size:10px; text-transform:uppercase; letter-spacing:.03em; }
```
Use `chip--solid` for "SELECTED YEAR"/"NEW" markers inside a row.

### 5.7 Buttons
| Variant | Use |
|---|---|
| **Primary** (filled `--primary`) | the one main action (Pay, Submit, Sign in) |
| **Ghost** (white, `--line` border, navy text) | Back, View details, secondary |
| **Soft** (`--primary-50` bg, primary text) | secondary action that must still be noticed ("Pay partial") |
| **Warm** (`#fff4ec` bg, `#e8590c` text) | time-sensitive CTA ("Apply now") |
| **Text link** (primary, 700) | tertiary ("Read more", "Change") |

```css
.btn-x { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:8px 14px;
         border-radius:var(--r-md); font-size:13.5px; font-weight:600; border:1px solid transparent; white-space:nowrap; }
.btn-x--primary { background:var(--primary); color:#fff; }  .btn-x--primary:hover { background:var(--primary-600); color:#fff; }
.btn-x--ghost   { background:#fff; border-color:var(--line); color:var(--navy); }
.btn-x--ghost:hover { border-color:var(--primary); color:var(--primary); background:#f5f7ff; }
.btn-x--soft    { background:#f3f5ff; border-color:#c9d1f5; color:var(--primary); font-weight:700; }
.btn-x--soft:hover { background:var(--primary); color:#fff; }
.btn-x--lg { height:48px; border-radius:var(--r-lg); font-size:15.5px; font-weight:700;
             box-shadow:0 8px 20px rgba(65,84,241,.25); }        /* form submit */
```
**Never** use an icon-only button for a non-obvious action — label it ("✎ Pay partial", not ✎).
Loading state: spinner + verb-ing text, button disabled ("Signing in…").

### 5.8 Form fields (input group with icon)
```html
<div class="fld">
  <div class="fld-label-row"><label for="suc">Student Unique Code <sup>*</sup></label>
    <a class="link-sm" href="">Where to find it?</a></div>
  <div class="inp" [class.is-invalid]="ctrl.invalid && ctrl.touched">
    <i class="bi bi-person-badge"></i>        <!-- or <span class="inp-prefix">+91</span> -->
    <input id="suc" placeholder="e.g. 2601000058">
  </div>
  <small class="fld-err">SUC must be 8–10 digits</small>   <!-- or .fld-hint -->
</div>
```
```css
.fld label { display:block; margin-bottom:6px; font-size:13.5px; font-weight:700; color:var(--text); }
.fld label sup { color:var(--bad); top:0; }
.inp { display:flex; align-items:center; gap:10px; height:48px; padding:0 12px; background:#fff;
       border:1.5px solid #dfe4ee; border-radius:var(--r-lg); transition:border-color var(--t), box-shadow var(--t); }
.inp:focus-within { border-color:var(--primary); box-shadow:var(--ring); }
.inp.is-invalid { border-color:#d02d2d; }
.inp > i { font-size:17px; color:var(--faint); }
.inp input { flex:1; min-width:0; height:100%; border:0; outline:0; background:transparent; font-size:15.5px; color:var(--navy); }
.inp input::placeholder { color:#aab4c8; }
.inp-prefix { padding-right:10px; border-right:1px solid #dfe4ee; font-weight:700; color:var(--muted); }
.fld-err  { display:block; margin-top:5px; font-size:12px; font-weight:600; color:#d02d2d; }
.fld-hint { display:block; margin-top:5px; font-size:12px; color:var(--muted); }
```
- Numeric fields: `inputmode="numeric"`; OTP = single wide input, 26px, letter-spacing .6em, `autocomplete="one-time-code"`.
- Validate on `(input)` not `(keyup)` (catches paste). Show a char counter on textareas (`120 / 500`).

### 5.9 Segmented switch (tabs)
```css
.seg { display:flex; gap:4px; padding:4px; border-radius:var(--r-lg); background:#eef1f7; }
.seg button { flex:1; padding:9px 0; border:0; border-radius:9px; background:transparent;
              font-size:14.5px; font-weight:700; color:var(--muted); }
.seg button.active { background:#fff; color:var(--primary); box-shadow:0 2px 8px rgba(1,41,112,.10); }
```
Used for Student/Parent login, New/History, Send-to options.

### 5.10 Alert
```css
.alert-x { display:flex; gap:8px; padding:10px 12px; border-radius:var(--r-md); font-size:13.5px; font-weight:600;
           background:#fff1f1; border:1px solid #f8c9c9; color:#b42323; }
.alert-x--ok   { background:#eefaf3; border-color:#c8ebd5; color:#166534; }
.alert-x--note { background:#fff8e6; border-color:#ffe3a3; color:#7a5200; }
```

### 5.11 Data table → cards on mobile
Desktop: grid rows with header row; totals row bold on `--surface-2`. Mobile (< 768): each row becomes a card, cells show `data-label`.
```css
.tbl-row { display:grid; grid-template-columns:minmax(160px,2fr) repeat(3,minmax(90px,1fr)) minmax(290px,1.8fr);
           align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--line-soft); }
.tbl-row--head { font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; background:var(--surface-2); }
.tbl-row.is-highlight { background:var(--primary-50); box-shadow:inset 3px 0 0 var(--primary); }
@media (max-width:767px){
  .tbl-row { grid-template-columns:repeat(3,minmax(0,1fr)); border:1px solid var(--line); border-radius:var(--r-lg); margin-bottom:10px; }
  .tbl-row--head { display:none; }
  .tbl-num::before { content:attr(data-label); display:block; font-size:11px; color:var(--muted); }
}
```
Numbers right-aligned; due amounts in `--bad`; paid rows get a `✓ Paid` chip instead of a button.

### 5.12 List row (receipts, feed)
Icon tile · title (primary, 700) + muted sub-line · amount right · chevron.
```css
.lrow { display:flex; align-items:center; gap:12px; padding:12px 14px; border:1px solid var(--line);
        border-radius:var(--r-lg); background:#fff; }
.lrow:hover { border-color:var(--primary); box-shadow:var(--sh-2); }
.lrow-icon { width:40px; height:40px; border-radius:var(--r-md); background:var(--primary-50); color:var(--primary);
             display:flex; align-items:center; justify-content:center; }
.lrow-amt { margin-left:auto; font-weight:800; color:var(--navy); }
```

### 5.13 Fact boxes (dl grid)
```css
.facts { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin:0; }
.facts > div { background:var(--surface-2); border:1px solid var(--line-soft); border-radius:var(--r-md); padding:9px 11px; }
.facts dt { font-size:11.5px; font-weight:600; color:var(--muted); }
.facts dt i { color:var(--primary); }
.facts dd { margin:0; font-size:13px; font-weight:700; color:var(--navy); }
```

### 5.14 Timeline / stepper
- **Term timeline:** dot (paid ✓ green / overdue ! red / upcoming clock grey) + vertical line + label + amount.
- **Form stepper:** numbered circles; completed shows ✓ (`content:"\F26E"` from Bootstrap Icons), current = primary filled, header shows "Step X of N".
- **Rounds:** pill chips with numbered circle (`1 Aptitude` `2 Technical` `3 HR`).

### 5.15 Skeleton & empty state
```css
.sk { height:14px; border-radius:8px; background:linear-gradient(90deg,#eef1f6 25%,#f7f9fc 50%,#eef1f6 75%);
      background-size:200% 100%; animation:sk 1.2s infinite; }
@keyframes sk { to { background-position:-200% 0; } }

.empty { text-align:center; padding:48px 20px; }
.empty > i { width:76px; height:76px; margin:0 auto 14px; border-radius:20px; background:var(--primary-50);
             color:var(--primary); font-size:40px; display:flex; align-items:center; justify-content:center; }
.empty h4 { font:800 19px "Nunito",sans-serif; color:var(--navy); }
.empty p { color:var(--muted); }
```
Empty state = icon + title + one helpful sentence + (optional) way out button.

### 5.16 Success state
Green circle ✓ (68px, `--good-bg` bg, `0 0 0 8px #f3fbf6` halo) + title + message + primary button to next step.

### 5.17 Mobile bottom tab bar (< 1200px)
6 items max: Home · Attendance · Academics · Tests · Fees · Profile. Active = primary colour + filled icon (`bi-house-fill`) on a 46×28 pill `#e8ebff`.
```css
.tabbar { position:fixed; inset:auto 0 0 0; z-index:996; display:flex; justify-content:space-around;
          padding:6px 4px calc(6px + env(safe-area-inset-bottom)); background:rgba(255,255,255,.97);
          backdrop-filter:blur(8px); border-top:1px solid #e8ecf4; box-shadow:0 -4px 16px rgba(1,41,112,.06); }
.tabbar a { flex:1; display:flex; flex-direction:column; align-items:center; gap:2px; color:#7b879f; text-decoration:none; }
.tb-icon { width:46px; height:28px; border-radius:14px; display:flex; align-items:center; justify-content:center; font-size:19px; }
.tb-label { font-size:10.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tabbar a.active { color:var(--primary); } .tabbar a.active .tb-icon { background:#e8ebff; }
```

### 5.18 Context chip ("Viewing student")
Header chip: photo/initials avatar · overline "VIEWING STUDENT" · name · sub-line `Class · Section · SUC · Year` · "Switch ▾" for parents. On mobile it becomes a full-width strip under the header (hidden on the child-picker page). A toast "Now viewing <name>" confirms a switch.

### 5.19 Auth screen (login / register)
Two-column shell (max 1040px, radius 20px, `--sh-3`): left **brand panel** (orange gradient `160deg #ff7a24 → #ff5e1a`, tagline, banner image, legal links); right **form panel** (logo 170px, title 26px, subtitle, form max-width 370px). ≤ 991px: form first, banner below; ≤ 575px: full-bleed, no radius.

### 5.20 Printable document (receipt)
Paper card max-width 480px, zig-zag bottom edge, green "Amount paid" band, meta + QR, student panel, items table with bold navy top border on total. `@media print` hides nav bars, removes shadows, keeps highlight colours with `print-color-adjust: exact`.

---

## 6. Icons

Bootstrap Icons, outline by default, **filled** for active nav state. Size 17–20px in headers/tiles.
Older Bootstrap Icons builds lack some glyphs — verify before use (`getComputedStyle(el,'::before').content`). Known-missing substitutes:

| Missing | Use instead |
|---|---|
| `bi-person-vcard` | `bi-person-badge` |
| `bi-copy` | `bi-clipboard` |
| `bi-bus-front` / `bi-bus` | `bi-truck` |
| `bi-person-exclamation` | `bi-exclamation-circle` |

Common map: attendance `bi-calendar-check`, academics `bi-journal-text`, tests `bi-trophy`, fees `bi-wallet2`, receipt `bi-receipt`, profile `bi-person`, feedback `bi-ui-checks`, drive `bi-briefcase`, back `bi-arrow-left`, home `bi-house-door`.

---

## 7. Interaction & UX rules

- Hover lift: `translateY(-2px)` + `--sh-2` + border → accent, `.15–.18s`.
- Focus: `--ring` on inputs; `:focus-visible` on clickable cards.
- Truncate long text with line-clamp (`truncate-1-lines`, `truncate-2-lines`) + "Read more" toggle for > 300 chars.
- Long lists: show 5–10, then "Show more".
- Destructive/irreversible actions need confirmation; money actions show the exact amount on the button ("Pay ₹18,750").
- Explain numbers that can look inconsistent (e.g. a receipt spanning two academic years → highlight the selected year's rows and show a split "Towards 2026-27 ₹1,000 / Other years ₹6,000").
- Dates in the past on pending items → "Overdue" (red tag); otherwise "Pending" (amber).
- Hash routes use full paths (`#/student/receipt/...`), never relative.

## 8. Accessibility

- Contrast ≥ 4.5:1 for text (muted `#6c7a96` on white passes for ≥ 13px bold / 14px regular).
- Every icon-only control gets `aria-label` + `title`.
- Tabs use `role="tablist"` / `aria-selected`; alerts use `role="alert"`.
- Tap targets ≥ 44px on mobile; inputs 48px high.
- Don't rely on colour alone — pair with icon/word.

## 9. Do / Don't

| Do | Don't |
|---|---|
| One primary button per card | Two filled buttons side by side |
| `₹1,18,750` | `118750` / `Rs.118750.00` |
| Skeleton while loading | Spinner in an empty page / "undefined" |
| Inline field error | `alert()` + `location.reload()` |
| Labelled secondary button ("Pay partial") | Bare ✎ icon |
| Grid that fills 100% width | Fixed `col-md-3` leaving gaps |
| Page-scoped class prefix (`fd-`, `jd-`) | Overriding Bootstrap classes globally |
| Navy-tinted shadows | `rgba(0,0,0,.3)` heavy shadows |

---

## 10. Checklist for a new screen

- [ ] Page header: title + subtitle (+ back/primary action)
- [ ] Active student/year visible (context chip)
- [ ] Attention/next action at top if something is due
- [ ] Cards use tokens (radius 14, border `--line`, `--sh-1`)
- [ ] Status = chip with colour + icon + word
- [ ] Loading skeleton, empty state, error alert
- [ ] Mobile: single column, table → cards, bottom tab bar space reserved
- [ ] Amounts in ₹ Indian format, dates `dd MMM yyyy`
- [ ] Icon glyphs verified to exist
- [ ] Print styles if the page is a document
- [ ] Bindings unchanged when doing a design-only pass
