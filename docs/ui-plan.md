# UI makeover — the plan (D266)

The look is drawn in the **Field Survey UI mock-ups** canvas,
https://claude.ai/artifact/JErKMqFFj5Awmd5G5iQa2u (version 7, 2026-11-07, after Claude's review
against the app). This file is its written form: the decisions, the tokens and components the
boards define, which board governs which screen, and the tasks (T174–T181 in `TASKS.md`) that
build it. The boards are the look, not the spec: where a board and `PLAN.md` or the app's
behaviour disagree, `PLAN.md` wins and the board is corrected.

## 1. Decisions (Landry, 2026-11-07, "take the defaults")

| # | Question | Decision |
|---|---|---|
| 1 | Sidebar names | The app's and PLAN §5's names stay: Levels, Needs review, Cable / riser, Dashboard, Rulings, Lint, Export, Setup, Vocabulary, Library, Sync, Projects. A makeover restyles; it does not rename. |
| 2 | Status-bar copy | The board's wording: "Synced 14:05" · "Offline · 3 edits waiting · 1 photo waiting · Last synced 13:40" · "Syncing…" · "Sign-in needed to sync". `describeSync` / `describeBlobs` change in T176 together with the flows that assert the old `Offline · N pending` (six today). |
| 3 | Dark mode | Light only: `userInterfaceStyle: "light"` in `app.json` (closes the 2026-10-11 follow-up, T25-11). It rides on T173's build cycle (D249). Tokens keep a dark theme cheap later. |
| 4 | Accent | Blue `#1F5FD6`, replacing the two ad-hoc blues (`#1565c0` in 33 files, `#1f6feb`). The Tweaks panel on the canvas still shows the alternatives. |
| 5 | Timing | Tokens (T174) and the device card (T175) **before the pilot** — T50 depends on T175, so surveyors pilot the card they will keep. The rest (T176–T181, milestone M6b) **after the T53 go/no-go**: the pilot shows what hurts in the field, and the rig makes a later restyle safe. |

Accepted with the look (new scope): the four summary tiles on the Levels home, per-level sizes on
Sync, the 72-pt rail on the plan, the Legend popover, one Filter button with a popover, the account
card on Sync. Not accepted: per-level cache removal on Sync (nothing in the app evicts one level),
the nav renames.

## 2. What the review changed on the canvas (so nobody re-litigates it)

- Levels table states are **Locked** or **Setup + Lock…** (the app's two); "In progress" / "Not
  started" did not exist. Plan column: On iPad / Downloading… / Download / No sheet yet.
- The plan toolbar keeps **Search**, the **filters** (Category / Status / Owner / Open punch, as one
  Filter button with a count) and **Layers**; Fit / Grid / Layers / Legend float bottom-right.
- The side panel shows its **Devices / Conns / Punch / Parts** tabs over the card; the card has
  every section the app has (Connections, Punch items with the DRAFT proposal card, Parts, Quick
  actions, History) and scrolls.
- Pins: a device with no status is **Unsurveyed**, grey `#757575` "–", the same hex the pins and
  the floor PDF use; `Not started` is a connection status. Legend gained Other (octagon), the
  in-review ring (`#FF8F00`) and the selected ring.
- Sync: no per-level Remove; "Download assigned levels" (D97); "Free uploaded photos"; an account
  card (T04 sign-in, the iPad label); Details with server, JS update id, update check, refused edits.
- Contrast: caption grey `#7A828E` (3.3:1 on the background) → `#5F6875` (4.8:1); warning text
  `#B26A00` on its tint (3.9:1) → `#8A5200` (5.8:1); `#9AA1AB` is glyph-only.
- D64: status buttons and rows use the **swatch with its glyph** (C · U · ! · NI · A · –) and
  rows carry the status word; a bare colour dot was colour as the only signal.
- Badges keep the words the flows assert: NEW · ↑n · IN REVIEW · DRAFT · DELETED · ⚑ R3a · 📷 n waiting.

## 3. The system (the "Tokens and components" board)

One file, `app/src/ui/tokens.ts`, exports these; nothing else in `app/src` spells a hex.

### Colour

| Token | Hex | Use |
|---|---|---|
| `bg` | `#F5F6F8` | screen background |
| `surface` | `#FFFFFF` | cards, the plan, the side panel |
| `surface2` | `#EEF0F3` | sidebar, table header rows, grey badges |
| `border` | `#D9DDE3` | control borders |
| `hairline` | `#E6E8EC` | row and card separators |
| `text` | `#14171C` | body |
| `text2` | `#4A515C` | labels, secondary text (8.0:1 on surface) |
| `text3` | `#5F6875` | captions, hints (4.8:1 on bg, 5.6:1 on surface) |
| `muted` | `#9AA1AB` | chevrons, "–" dashes, dashed outlines — **never text** |
| `primary` | `#1F5FD6` | accent: active nav, primary buttons, links, selected ring |
| `primaryPressed` | `#1A4EB0` | pressed primary |
| `primaryTint` | `#E4ECFA` | active nav background, selected chips, info banners |
| `danger` / `dangerTint` | `#C62828` / `#FDECEC` | destructive, errors, the Issue count |
| `warning` / `warningTint` | `#8A5200` / `#FFF4D6` | offline, in review, needs attention |
| `success` / `successTint` | `#2E7D32` / `#EEF7EE` | synced, saved, exported |

Status fills are **imported from `plan/pins.ts`** (`STATUS_STYLE`), never copied: Complete
`#2E7D32` C · Installed, untested `#6A1B9A` U · Issue `#C62828` ! · Not installed hollow `#C62828`
NI · No access `#F9A825` A (dark glyph) · Unsurveyed / Not started `#757575` – / ·. Rings: in review
`#FF8F00`, selected `primary` (was cyan `#00bcd4`; T177).

`ui/contrast.test.ts` (vitest) asserts every text token ≥ 4.5:1 on `bg`, `surface` and `surface2`,
and white ≥ 4.5:1 on `primary`, `danger`, `success`.

### Type (the system font; iOS sizes)

| Style | Size / line / weight | Where |
|---|---|---|
| display | 28 / 34 / 600 | screen title |
| title | 22 / 28 / 600 | section title on a page |
| headline | 17 / 22 / 600 | card title, row title, level code |
| body | 17 / 22 / 400 | notes, field values |
| callout | 15 / 20 / 400 | nav, buttons (600), table cells, hints |
| caption | 13 / 18 / 400 | labels, sub-lines, table headers |
| micro | 11 / 13 / 600 | pin labels and the legend only |

Numbers are tabular (`fontVariant: ['tabular-nums']`). Spacing 4 · 8 · 12 · 16 · 24 · 32. Radius 8
controls · 12 cards · pill. Hit target 44 pt: a 36- or 40-pt control gets `hitSlop` to 44.

### Components (`app/src/ui/`)

| Component | Replaces | Notes |
|---|---|---|
| `Btn` | `setup/widgets.tsx` Btn, `sync.tsx` Btn, the ad-hoc Pressables | primary · secondary · tertiary · destructive; `small`, `loading`, `disabled`, icon slot; `testID` through |
| `Field` | `setup/widgets.tsx` Field | label, hint, error, focused border; `onCommit` kept (D45) |
| `Chip` | the per-screen chip styles | filter · selected · vocabulary (40 pt + hitSlop) |
| `Badge` | `plan/chips.tsx` BadgeStrip | the §2 words, tinted; `↑n` and `📷 n` tabular |
| `Swatch` | `plan/chips.tsx` Swatch | status square with glyph, 20–22 pt; hollow for Not installed |
| `Card`, `Row`, `Section` | per-screen styles | 12-pt card, 48/52-pt rows with hairlines, collapsible Section with count |
| `Banner`, `Toast`, `Empty` | `Notice`, inline texts | info / success / warning / danger banners; the dark pill toast; the empty state with one action |
| `Sidebar`, `Rail`, `StatusStrip` | `index.tsx` sidebar, `components/StatusBar.tsx` | T176 / T177 |

`setup/widgets.tsx` and `plan/chips.tsx` keep exporting their names and props over the new
primitives, so screens change only when their own task comes. Icons: the boards draw them as
inline SVG, but `react-native-svg` is not in CLAUDE.md §5's native list and would need a build, so
the app draws them with `@shopify/react-native-skia` (already native) through one `Icon` component in
`ui/icons.tsx`, or keeps a text glyph where one already serves (◀, ▸, ⋯). Adding `react-native-svg`
is a decision for `DECISIONS.md` first (D266 (7) refuses it for now).

## 4. Boards → screens → tasks

| Board | Governs | Task |
|---|---|---|
| Tokens and components | every screen | T174 |
| Plan · rail, card, status buttons — the side panel | `card/DeviceCard.tsx` | T175 |
| Levels · the shell | `app/index.tsx`, `components/StatusBar.tsx`, the sidebar on every full-width screen | T176 |
| Plan · rail, card, status buttons — the rest | `plan/PlanScreen.tsx`, `plan/GridPanel.tsx`, the legend | T177 |
| Sync · Details | `app/sync.tsx`, `sync/screen.ts` | T178 |
| (no board: the system applied) | `review.tsx`, `lint.tsx`, `rulings.tsx`, `dashboard.tsx`, `cables.tsx` | T179 |
| (no board: the system applied) | `setup/*`, `library.tsx` + `library/*`, `vocabulary.tsx`, `export.tsx`, `projects.tsx`, `new-project.tsx`, `rule-defaults.tsx` | T180 |
| — | regression on the rig, the on-device round | T181 |

A screen without a board takes the shell's page pattern: title (display) with a caption under it and
one primary action at the right; tables as a card with a `surface2` header row; filters as chips;
forms as `Field`s in a card. No layout redesign and no renamed label in T179/T180: if a screen needs
one, it is filed as a task, not done in passing.

## 5. Rules for every makeover task

- **testIDs unchanged.** Every `<screen>.<element>` that a flow taps keeps its ID; a new control
  gets a new ID in the same task (`plan.filter`, `plan.legend`, `plan.grid`).
- **Words unchanged** except decision 2: screen names, badge words, the vocabulary of CLAUDE.md §3,
  button labels the flows tap by text. A flow that tapped a label that moved into an icon button
  taps the new ID instead, in the same commit.
- **No native module.** Skia, the existing fonts, `expo-router`. Anything else is a decision first.
- **One `tokens.ts`.** A screen that still spells a hex after its task is a defect of that task.
- **The rig proves it** (`docs/rig-plan.md` §7 applies): each task names its flows; green twice on
  A, once on B where there is a B half; commit per green flow; the task entry grows a progress line
  per flow. Information checks (is the wording right, does it read at arm's length) go to Landry
  through the on-device checklist.
- **Performance holds.** `[rules] run` and `[sync] synced` ms, and the plan's pan/zoom, are not the
  restyle's to change; `docs/perf/t131.md` numbers are re-read in T177 and T181.
- **Update rule.** JS-only tasks end with `eas update` to `production` (CLAUDE.md §6); T174's
  `app.json` change is the one exception and rides on T173's build.

## 6. What the boards do not show (decided here so the tasks need not ask)

- The card **scrolls**; the board clips at Parts on purpose. Sections remember open/closed per card
  while the card is open; Status, Notes and the address rows are always open.
- **Popovers** (Filter, Layers, Legend, the project button's menu): a `surface` card with a 12-pt
  radius and the card shadow, anchored to its button, dismissed by a tap outside. The Filter popover
  holds the four groups as chip rows and a Clear button; its count badge is the number of active
  groups.
- The **rail** (72 pt) is the plan screen's sidebar; its top button opens the full sidebar as an
  overlay over the plan. Every other screen keeps the 240-pt sidebar.
- The **project button** opens the Projects screen (switch, Refresh from server, + New project, the
  app library); the home's project chips go away with it (T176).
- **Needs review** A/B, the **Setup** steps, **Export** history and the **Dashboard** charts keep
  their layouts; only tokens, primitives and the page pattern change (T179, T180).
- **iPhone** (T62) is out of scope; the tokens are what it will build on.

## 7. Order

```
T173 (builds) → T174 tokens → T175 card → T50…T53 pilot → go/no-go
  → T176 shell → T177 plan ─┐
                 T178 sync ─┼→ T181 regression + on-device round
                 T179 review screens ─┤
                 T180 setup and the rest ─┘
```

T177–T180 are independent once T176 is in; two can run as parallel sessions on A and B when the
flows they run keep the server up (`mac-rig-two-simulators` in Claude's memory, `docs/ops.md` §6).

## 8. Tracker

| Task | Status | Date | Flows green | Found |
|---|---|---|---|---|
| T174 tokens and primitives | todo | | | |
| T175 device card | todo | | | |
| T176 shell | todo | | | |
| T177 plan screen | todo | | | |
| T178 Sync screen | todo | | | |
| T179 review screens | todo | | | |
| T180 setup and the rest | todo | | | |
| T181 regression and on-device round | todo | | | |
