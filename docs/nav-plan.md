# Navigation rework — the plan (D280)

Status: **approved** (Landry, 2026-11-17, "take the defaults"): D280 in `DECISIONS.md`, tasks T188–T192
in `TASKS.md` (M6c). JavaScript only: no native module, no new dev build, `eas.json` untouched.

## 1. What is wrong today

There is no shared back control. Each screen builds its own, so the way out sits in a different
place, with a different glyph, and means a different thing depending on the screen.

| Where | The way out | Position | Glyph | What it does |
|---|---|---|---|---|
| Levels home | none (it has the 240-pt sidebar) | — | — | — |
| Plan | `Levels` / `Needs review` / `Back` … | top left, in the toolbar | chevron icon | history back; the label names the screen under it |
| Needs review, Lint, Rulings, Dashboard, Cable / riser, Export, Sync | `← Levels` | **top right**, in the header's actions, before the other buttons; wraps under the title when the row is full | `←` | always jumps to Levels, whatever screen you came from |
| Vocabulary, Library (project) | `◀ Levels` | top right | `◀` | jumps to Levels |
| Projects | `◀ Levels` | top right, first of four buttons | `◀` | jumps to Levels |
| Rule defaults, Library (app) | `◀ Projects` | top right | `◀` | jumps to Projects |
| Needs review (app library) | `← Library` | top right | `←` | `navigate`, a third mechanism |
| Setup | `◀ Projects` + `Open the levels screen ▸` | top left of the step column + bottom left | `◀` / `▸` | says Projects even when you came from the sidebar |
| New project | `◀ Projects` + `Cancel` | top left + bottom right | `◀` | two controls, two different targets |
| End editor, item editor (side panel) | `◀ <device ID>` / `◀ Connections` / `◀ Cables` | top left of the panel | `◀` text | closes the editor |
| Rulings preview | `Back` | **right end** of a button row, after Apply | none | back to the edit form |
| Device card | `×` | top right of the card | icon | closes the card |
| Crops, photo viewer | `Close` | varies | text | closes the overlay |

Four things follow from that table:

1. **Position.** The most-used exit (`← Levels`) is top right on nine screens and top left on the
   plan, Setup and New project. On the header screens it shares a wrapping row with the screen's
   own actions, so it also moves between screens and between portrait and landscape.
2. **Meaning.** On the plan, back returns to where you came from. On the header screens it always
   goes to Levels. Dashboard → *Apply as ruling* → Rulings → `← Levels` drops you on Levels, not on
   the Dashboard you were working in; the same for Needs review → Lint, Cable / riser → a review
   item, Export → Lint and Sync → Needs review.
3. **The sidebar is missing.** Only Levels has the sidebar and only the plan has the rail. Every
   other screen has neither, which is why each one needs a `← Levels` button at all: to move from
   Lint to Rulings you go Levels → Rulings. `docs/ui-plan.md` §6 says "every other screen keeps
   the 240-pt sidebar"; that line was never built.
4. **The stack grows.** The sidebar and the rail `push`, so Plan → rail → Lint → a finding → Plan →
   rail → Dashboard leaves six screens mounted, each reloading on every sync. The rail even pushes
   a second copy of Levels (`ui/Rail.tsx:52`), which T185 removed from the sidebar for that reason.

## 2. The model

Three kinds of place, each with one fixed way out.

**Sections** are the sidebar's entries: Levels, Needs review, Cable / riser, Dashboard, Rulings,
Lint, Export, Setup, Vocabulary, Library, Sync, and Projects behind the project button. You move
between sections with the sidebar, which is on every screen. A section you reached from the sidebar
has **no back button**, because there is nothing to go back to.

**Details** are screens you drilled into from another screen: the plan (from Levels, a review
item, a Lint finding, a dashboard row, a cable end), New project / Rule defaults / the app library /
Setup when opened from Projects, and any section opened by a link inside another screen (Rulings
from *Apply as ruling*, Lint from Needs review). A detail always has a back button, **top left**,
and it always returns to the screen you came from and names it: `‹ Dashboard`.

**Panels** live inside a screen: the device card, the end and item editors, the rulings preview,
crops, the photo flow, dialogs. They are not routes and the rules for them are in §2.3.

### 2.1 One bar, one position

A single `NavBar` component sits at the top of every route, at a fixed height, in this order:

```
[ ‹ Dashboard ] | Title · caption                              [ actions … ] [ primary ]
  ^ fixed slot, top left; empty on a section                    ^ never a way out
```

- The back slot is the first thing in the bar, left-aligned, 44-pt target, one chevron icon
  (`chevronLeft`, as the plan has now) plus the destination's name. `←` and `◀` go away as back
  glyphs. `▸` stays for forward links.
- The actions at the right are the screen's own (filters stay under the bar). A way out is never
  among them, so the row no longer changes what the first button is.
- The plan's toolbar already has this shape; it takes the shared back button and nothing else
  changes there.
- The iPad's edge swipe does the same thing as the back button, since both are now history back.

### 2.2 The shell and the stack

- One `Shell` wraps every route: the sidebar or the rail on the left, the screen on the right. It
  takes the current section so the entry is drawn active.
- A sidebar or rail tap **resets** the stack to `Levels → that section` instead of pushing (Levels
  itself: just Levels). The stack is then never deeper than Levels → section → the details you
  opened from it, so back is always short and predictable, and screens stop piling up mounted.
- The rule for showing back is one line: *a section directly on Levels shows none; everything else
  shows back, labelled with the screen under it* (`backLabelFor` in `app/src/plan/toolbar.ts`
  already maps route names to labels and is tested).
- Setup from the sidebar: no back. Setup from Projects: `‹ Projects`. Its `Open the levels screen ▸`
  link goes away; the sidebar's Levels entry does that.
- The app-level screens (Projects, Rule defaults, the app library and its review, New project)
  get the shell too, with the project entries dim when no project is open, as the sidebar does now.

**Built in T188 (D281).** `ui/Shell.tsx` is a **wrapper each route renders**, not a route-group
layout: no file moves, so the route names `backFor` reads stay the file names (a vitest checks each
one against `app/src/app`). A section switch does not slide the rail because a section directly on
Levels appears and leaves with `animation: 'none'` and takes no edge swipe (`transitionFor`, set
in the root layout's `screenOptions`); details still slide. The rule lives in `ui/navStack.ts`
(`sectionTap`, `backFor`, `backLabelFor`, `transitionFor`); `ui/useNav.ts` has `useSectionTap`
(→ `navigation.reset`, keeping the Levels home's key so it is not remounted) and `useBack`.
`ui/NavBar.tsx` (with `BackButton`) and `ui/PanelHeader.tsx` are ready for T189 and T191; in
T188 only the plan's toolbar takes `BackButton`.

### 2.3 Panels

| Kind | Control | Position |
|---|---|---|
| A panel that replaced another panel (end editor over the card or the list, item editor, rulings preview over the edit form) | `‹ <where it returns>` | top left of the panel |
| A panel or overlay that closes to nothing (device card, crops, photo viewer) | `×` icon | top right of the panel |
| A form or dialog that would discard input | `Cancel` then the primary button | bottom right, Cancel on the left of the two |

One `PanelHeader` component draws the first two. The rulings preview's `Back` moves from the end of
its button row to the panel's top left; the crops' and the photo viewer's `Close` text buttons
become the `×`. New project keeps `Cancel` at the bottom and its top-left back, and both go to
Projects.

## 3. Decisions (Landry, 2026-11-17, "take the defaults": the recommendation in each)

1. **Rail or full sidebar on the screens that have neither today.** Recommended: the **72-pt rail**
   on every screen except Levels (which keeps the 240-pt sidebar), its top button opening the full
   sidebar as an overlay, exactly as on the plan. The tables on Cable / riser, Dashboard and Needs
   review need the width, most of all in portrait, and it makes every working screen look like the
   plan. This replaces the unbuilt line in `docs/ui-plan.md` §6. The alternative is the 240-pt
   sidebar everywhere but the plan, collapsing to the rail in portrait.
2. **Sections lose their back button.** `← Levels` disappears from nine screens; Levels is the
   rail's first icon instead. This is the largest visible change and the one that removes the
   moving button.
3. **Back means "where I came from", everywhere.** Rulings opened from the Dashboard returns to the
   Dashboard. The alternative (back always goes to a fixed parent) is what the header screens do
   today and is what makes cross-links a dead end.

## 4. What does not change

- Routes and URLs, params, and every screen's content and layout below the bar.
- The sidebar's entries, names, order, count pills and `nav.*` / `rail.*` test IDs.
- `plan.back`, `end.back`, `item.back`, `rulings.back`, `card.close` keep their IDs (they are in
  91, 26, 3, 5 and 91 flow steps). New back buttons get `<screen>.back`.
- The global status strip, the plan's toolbar contents, the card.

## 5. Flow impact (the Mac rig)

- `setup.home` (44 steps) becomes `rail.levels`; `sync.back` (2 steps) likewise.
- Flows that tap `nav.*` from Levels are unchanged. Flows that today go back to Levels only to
  reach another section can keep doing so; they get shorter if rewritten, which is not required.
- Flows that tap a visible `← Levels` / `◀ Projects` text need the new ID.
- Percentage taps on header screens move by the rail's 72 pt, as they did on the plan in T177.

## 6. Tasks (M6c in `TASKS.md`, which holds the definitions of done of record)

| # | Task | Model | Depends | Definition of done |
|---|---|---|---|---|
| T188 | The shell, the bar and the stack rule | O/M | — | `ui/Shell.tsx`, `ui/NavBar.tsx` (with `BackButton`), `ui/PanelHeader.tsx`; one pure module for "which stack action does a section tap take" and "does this screen show back, with which label", unit-tested; the sidebar and the rail both use it (the rail stops pushing Levels); Levels and the plan are on it with no visible change other than the shared button. Settles on the rig whether the shell is a wrapper per screen or a route-group layout (the wrapper moves no files, but a section switch must not animate the rail). `smoke`, `place`, `lists` green. |
| T189 | The section screens onto the shell | O/M | T188 | Needs review, Lint, Rulings, Dashboard, Cable / riser, Export, Vocabulary, Library, Sync: rail + `NavBar`; `← Levels` removed; opened from another screen's link they show `‹ <that screen>` and return to it. A flow proves Dashboard → Rulings → back lands on Dashboard. Their flows green. |
| T190 | Projects, Setup and the app-level screens | S/M | T188 | Projects, New project, Rule defaults, the app library and its review, Setup: the shell; back top left only when opened from Projects; `setup.home` → `rail.levels` across the flows; `setup`, `drafts`, `projects`, `e2e` green. |
| T191 | Panels | S/M | T188 | End editor, item editor, the cables end editor and the rulings preview on `PanelHeader` (back top left); crops and the photo viewer close with `×` top right; every dialog's `Cancel` sits left of its primary at the bottom right. `ends`, `cables`, `additions`, the photo flow green. |
| T192 | Regression and the on-device round | S/M | T189, T190, T191 | Every flow green on A, the peer flows on B; no `← ` / `◀ ` back text left in `app/src`; `docs/ui-plan.md` §6 and PLAN §5 updated; checks added to the on-device checklist (thumb reach of the top-left back in both orientations, the edge swipe against plan pan and ink, the rail's width on the tables in portrait). Ships as one OTA update. |

T189, T190 and T191 touch different files and can run in any order after T188.
