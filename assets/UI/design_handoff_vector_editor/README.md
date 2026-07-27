# Handoff: RocketJet Vector Editor (non-technical quick-edit UI)

## Overview
A browser-based vector/SVG editor aimed at **non-technical users making quick edits** to a supplied logo/artwork file. The user can select layers, move/resize/rotate them, edit text properties, find-and-replace colours in the vector artwork, reorder/hide/duplicate/delete layers, undo/redo, and export an SVG. Two commercial flows are stubbed in: a gated **AI editing** upsell, and an **export rating** gate that also offers an "abandon export" feedback path.

The layout is a **full-bleed canvas with floating panels** — deliberately no fixed sidebars, so the artwork stays the focus.

## About the Design Files
The file in this bundle (`RocketJet Editor.dc.html`) is a **design reference created in HTML** — a working prototype that shows the intended look and behaviour. It is **not production code to copy directly**. It uses a small in-house template runtime (`<x-dc>`, `{{ }}` holes, `sc-for`/`sc-if`, and a `Component extends DCLogic` class that is React-class-like) which will not exist in your codebase.

Your task is to **recreate this design in the target codebase's existing environment** (React, Vue, Svelte, SwiftUI, etc.) using its established patterns, component library and state management. If no environment exists yet, pick the most appropriate framework and implement there. The logic class maps almost 1:1 onto a React class/function component: `state` → component state, `renderVals()` → derived values passed to JSX, template markup → JSX.

Open the HTML file in a browser to interact with it.

## Fidelity
**High-fidelity.** Colours, type sizes, spacing, radii, shadows and interaction states are all final and are listed exactly below. Recreate pixel-for-pixel using your codebase's primitives where they exist. The only intentionally rough part is the **artwork itself** — a placeholder composition of a rounded square, two circles and a bar, standing in for a real imported SVG (see *Artwork model* below).

---

## Screens / Views

There is one screen (the editor) plus three modal overlays.

### 1. Editor (root)
Full viewport, `position:relative`, background `#eef0f3`, text `#1b1f24`, `overflow:hidden`.

#### 1.1 Canvas area
- Absolutely fills the root (`inset:0`), flex-centred, `overflow:hidden` (deliberate — prevents scrollbars when artwork is dragged past the edge).
- **Board**: 380 × 380 px, white, `box-shadow:0 16px 44px rgba(0,0,0,.16)`, `flex:none`, `position:relative`. All object coordinates are relative to this board. `data-board="1"` is used to read its bounding rect for rotation maths.
- Pointer-down on empty canvas → deselect.

#### 1.2 Object rendering
Each non-background object is an absolutely positioned box: `left:x px; top:y px; width:w px; height:h px; transform:rotate(rot deg); transform-origin:center center; cursor:move`. Hidden objects render at `opacity:.35` when selected, otherwise `display:none`.

- **Text object**: full-size flex-centred div; `font-family`, `font-size`, `font-weight`, `color` from the object; `text-align:center; line-height:1.05; user-select:none; white-space:nowrap`.
- **Background object**: `position:absolute; inset:0` filled with its colour; when selected gets `outline:2px solid #5b6cff; outline-offset:-2px`.
- **Artwork object**: a relative 100%×100% box containing the shape list (below), each shape an absolutely positioned div with percentage geometry.

#### 1.3 Selection overlay (on the selected object)
A `position:absolute; inset:-8px` box, `border:1.5px dashed #5b6cff`, `pointer-events:none`, `z-index:5`, containing four `pointer-events:auto` controls:
- **Rotate stem**: 1.5px × 22px line, `#5b6cff`, at `top:-30px; left:50%`.
- **Rotate handle**: 20 × 20 circle at `top:-42px; left:50%`, white fill, 1.5px `#5b6cff` border, glyph `⟳` 10px `#5b6cff`, `cursor:grab`, `box-shadow:0 2px 6px rgba(0,0,0,.18)`.
- **Move handle**: 22 × 22, radius 6, solid `#5b6cff`, white `✥` 11px, at `top:-11px; right:-11px`, `cursor:move`.
- **Resize handle**: 22 × 22, radius 6, white with 1.5px `#5b6cff` border, `⤢` 11px `#5b6cff`, at `bottom:-11px; right:-11px`, `cursor:nwse-resize`.
- **Size badge**: at `bottom:-24px; left:0`, `#5b6cff` fill, white 10px monospace, padding `2px 6px`, radius 4 — reads `{w} × {h}` (rounded).

#### 1.4 Dev rail (top-left) — internal only
Marked clearly as an internal/dev affordance, dark so it never reads as user UI.
- **Collapsed**: pill at `top:16px; left:16px`, background `#181b20`, radius 10, padding `8px 11px`, `box-shadow:0 6px 18px rgba(0,0,0,.25)`; amber `⚙` (`#f2b03e`) + "DEV" 10px/700/letter-spacing .6px `#9aa0ab` + `›` `#7c828e`. Click expands.
- **Expanded**: 198px wide panel, `#181b20`, radius 12, `box-shadow:0 10px 30px rgba(0,0,0,.28)`. Header "⚙ DEV — DOWNLOADS" 9px/700 `#f2b03e` with `‹` collapse. A disabled-looking select row ("Select a vector…") `#22262e`, 1px `rgba(255,255,255,.08)`, radius 7. Then a "SAMPLES" label 9px/700 `#5b616d` and a scrolling list (max-height 150px) of sample cards: 48px hatched thumbnail, 10px caption; the active one carries a 1.5px `#5b6cff` border and `#8f9bff` caption. `z-index:30`.

#### 1.5 Top toolbar (top-centre, floating)
`top:16px; left:50%; translateX(-50%)`, white, 1px `#e6e8eb`, radius 12, padding 6, `box-shadow:0 10px 30px rgba(0,0,0,.12)`, `z-index:20`, flex, gap 4.
Contents in order: 22×22 radius-6 `#5b6cff` app chip (`◆`, white 11px) · filename "RocketJet-logo.svg" 13px/600 · 1px×20px divider `#e6e8eb` · Undo `↶` · Redo `↷` (15px icon buttons; colour `#4b5563` when available, `#d3d7dd` when the stack is empty) · divider · "⤢ Center" · "⟳ 90°" (12.5px, `#4b5563`, radius 8, hover background `#f2f4f7`) · divider · **Export** primary button (`#5b6cff`, white, 12.5px/600, padding `7px 14px`, radius 8, label "↓ Export").

#### 1.6 Inspector (top-right, floating, closeable)
`top:76px; right:16px`, width 252, white, 1px `#e6e8eb`, radius 12, `box-shadow:0 16px 40px rgba(0,0,0,.15)`, `max-height:calc(100vh - 200px)`, `overflow-y:auto; overflow-x:hidden` (x hidden is deliberate — it removed a stray horizontal scrollbar), `z-index:15`.
Header row: title 12.5px/700 + `✕` close (`#9aa1ab`, deselects). Title text depends on selection: `Editing text` / `Background` / `Vector colours` / `Nothing selected`.

Body padding `0 14px 14px`. All labels are 11px `#6b7280` with 5–6px bottom margin. All inputs: full width, `box-sizing:border-box`, 1px `#d7dbe1`, radius 8, padding `9px 10px`, 13px. Focus state (global): `border-color:#5b6cff; box-shadow:0 0 0 3px rgba(91,108,255,.15)`, no default outline.

- **Text selected** — "Words" text input (live, uncommitted to undo per keystroke); "Font" select (Arial, Georgia, Verdana, Trebuchet MS, Courier New, Impact); a two-column row (gap 10) of "Size" (number) and "Weight" (select: 400 Regular / 500 Medium / 700 Bold / 800 Black); "Color" — a wrapping row (gap 8) of 24×24 radius-6 swatches from the text palette plus a dashed 24×24 "+" tile wrapping a hidden `<input type="color">`. Selected swatch: `outline:2px solid #5b6cff; outline-offset:2px`.
- **Background selected** — "Canvas color" with the same swatch row, background palette, same custom "+" tile.
- **Artwork selected** — **Find & replace colours** (see below).
- **Nothing selected** — helper copy, 12px `#9aa1ab`, line-height 1.6: "Select the **Text** layer to edit type, the **artwork** to swap its colours, or drag anything to move, resize and rotate it." (bold spans in `#4b5563`).

##### Find & replace colours (artwork selected)
- Label "Find & replace colours"; sub-copy 11px `#9aa1ab`: "Click a colour to recolour every shape in the artwork that uses it."
- One row per **unique colour in the artwork** (not per shape). Row is a `<label>` wrapping a transparent full-bleed `<input type="color">`: flex, gap 10, 1px `#eceef2`, radius 9, padding `6px 8px`, `cursor:pointer`, hover background `#f2f4f7`; contains a 22×22 radius-6 swatch of the colour (white gets a 1px `#d7dbe1` border), the uppercase hex in 11px monospace `#4b5563`, and a `✎` 12px `#9aa1ab` affordance.
- Changing a row's colour (on `change`, not `input` — one undo entry per pick) replaces **every shape** referencing that palette entry. This is the core of the feature: the artwork's shapes reference palette *indices*, so one edit recolours all matching shapes at once.

#### 1.7 Layers / Elements panel (bottom-left, floating)
`left:16px; bottom:16px`, width 214, white, 1px `#e6e8eb`, radius 12, `box-shadow:0 10px 30px rgba(0,0,0,.14)`, `z-index:15`.
Header: "ELEMENTS · {count}" 10px/700/letter-spacing .5px `#9aa1ab`, plus a `＋` (15px `#c3c9d2`) that adds a text layer.
List: `max-height:170px; overflow:auto`, padding `0 8px 8px`, gap 2. Rows are **top = front** (the object array is reversed for display).
Each row: flex, gap 7, padding `7px 8px`, radius 8, `draggable`; selected row gets background `#eef0ff` + 1px `#d7dcff`, others 1px transparent. Contents: drag grip `⠿` (`#c3c9d2`, `cursor:grab`) · type icon 13px (`🅣` text / `◆` artwork / `▨` background) · name 13px (selected: 600 `#1b1f24`; hidden: `#b6bcc6`; else `#4b5563`) · action cluster (gap 7): eye `◉`/`○` (`#5b6cff` visible, `#c3c9d2` hidden), duplicate `⧉` `#8a93a3`, delete `✕` `#e0575b` — all 12px, all `stopPropagation` so they don't also select.
Drag-and-drop reorders; the list index must be converted back to the underlying array index (`arrayIndex = length - 1 - rowIndex`).

#### 1.8 AI pill (bottom-right)
`right:16px; bottom:16px`, `background:linear-gradient(90deg,#5b6cff,#8f6bff)`, radius 11, padding `11px 15px`, `box-shadow:0 10px 26px rgba(91,108,255,.35)`, `z-index:15`. Contents: `✦` 13px · "Customise with AI" 12.5px/700 white · "PRO" badge 9px/700 white on `rgba(255,255,255,.28)`, padding `2px 6px`, radius 5. Click opens the Unlock AI overlay.

---

### 2. Overlay — Unlock AI editing (`z-index:80`)
Backdrop `rgba(16,19,24,.46)` filling the root, flex-centred; clicking the backdrop closes (inner card stops propagation).
Card: 376px, white, radius 14, `box-shadow:0 24px 60px rgba(0,0,0,.3)`, `overflow:hidden`.
- Header (padding `18px 20px 0`): 26×26 radius-8 chip `linear-gradient(135deg,#5b6cff,#8f6bff)` with white `✦`; title "Unlock AI editing" 15px/700; `✕` close at right (`#9aa1ab`).
- Body copy 12.5px `#6b7280` line-height 1.55: "You need an active subscription or credits to use the AI features on this asset."
- Section label "AI FEATURES" 10px/700/letter-spacing .5px `#9aa1ab`.
- Two feature cards (1px `#eceef2`, radius 10, padding 12, flex gap 11, icon 14px `#5b6cff`):
  1. **Suggests fonts** — "Recommends Google Fonts that match the design's style and mood."
  2. **Converts text paths to editable text** — "Detects lettering baked into outlines and turns it back into real, editable text."
  Feature titles 13px/600; descriptions 12px `#6b7280` line-height 1.5.
- Footer (right-aligned, gap 8): "Maybe later" ghost (`#6b7280`, 12.5px) and "Upgrade to unlock" (gradient `90deg,#5b6cff,#8f6bff`, white, 12.5px/700, padding `9px 17px`, radius 8). In the prototype both simply close; wire "Upgrade" to your billing flow.

### 3. Overlay — Export rating (`z-index:60`)
Opens when **Export** is clicked. **The SVG is generated but NOT downloaded yet** — this modal gates the download.
Backdrop `rgba(16,19,24,.42)`. Card 330px, white, radius 14, `box-shadow:0 24px 60px rgba(0,0,0,.28)`, padding `22px 22px 18px`.
- Title "How did that export go?" 15px/700. Sub-copy "Rate it and we'll start your download." 12.5px `#6b7280`.
- **Five stars**, `★` at 29px, gap 6, `cursor:pointer`, `transition:color .12s, transform .12s`. Filled `#f2b03e` up to `max(hoverStar, rating)`, otherwise `#dfe3e9`; hovered stars scale to 1.12. `title` = "n of 5". Mouse-leave clears hover.
- **When rating === 1** an inset warning block appears: background `#fff5f5`, 1px `#f7d7d8`, radius 10, padding `11px 12px`; copy 12.5px `#8a3d40`: "Sorry that missed the mark. You can abandon this export before it downloads and tell us why."; plus an **Abandon export** button — white fill, 1px `#e0575b`, text `#c94146`, 12.5px/600, padding `8px 13px`, radius 8 — which opens overlay 4.
- Footer: "Cancel" ghost (discards the pending file, no download) and **"Send rating & download"** — background `#5b6cff` when a rating is set, `#c3c9d2` when not; clicking with no rating does nothing. On click: fire the download, record the rating, close.

### 4. Overlay — Reasons for cancelling (`z-index:70`)
Backdrop `rgba(16,19,24,.5)`. Card 352px, white, radius 14, padding `22px 22px 18px`, `max-height:88vh; overflow:auto`.
- Title "Why are you abandoning this export?" 15px/700; sub-copy "Pick anything that applies. It goes straight to the team." 12.5px `#6b7280`.
- **Multi-select** reason rows (gap 6): flex, gap 10, padding `8px 9px`, radius 9, 1px `#eceef2` (selected: 1px `#d7dcff` + background `#f4f6ff`), hover `#f2f4f7`. Each has a 17×17 radius-5 box — unselected: white with 1px `#cdd3db`; selected: `#5b6cff` fill with a white 11px `✓` — and a 13px `#374151` label. Reasons:
  1. Colours or fonts came out wrong
  2. File looks different from the canvas
  3. Wrong file type for what I need
  4. Text got cut off or moved
  5. Took too long to export
  6. Made a mistake — starting over
- Optional note: label "Anything else? (optional)"; `<textarea>` placeholder "Tell us what happened…", `min-height:64px`, `resize:vertical`, same input styling.
- Footer: "Back" ghost (returns to the rating modal) and **"Abandon & send"** (`#e0575b`, white, 12.5px/600, padding `8px 16px`, radius 8) — sends the feedback, discards the pending file, closes everything. **No download happens on this path.**

---

## Interactions & Behavior

### Selection
- Pointer-down on any object selects it; pointer-down on empty canvas deselects (`selectedId = null`).
- Clicking a layer row selects; the row's eye/duplicate/delete controls must stop propagation.
- Selecting the background only selects — it is never draggable.

### Direct manipulation (window-level pointer listeners)
A single `drag` descriptor (`{mode, id, …origin values}`) is set on pointer-down and cleared on pointer-up; `pointermove` is bound on `window` so drags survive leaving the element.
- **move** — new `x/y` = origin + (clientX/Y − startX/Y).
- **resize** — new `w = max(24, ow + dx)`, `h = max(20, oh + dy)`; for text the font `size` scales proportionally with height: `round(originalSize × h / originalH)`, floored at 8.
- **rotate** — centre is the board rect origin plus the object's centre; `rot = round(atan2(clientY − cy, clientX − cx) × 180/π + 90)`.
- Each drag pushes **one** undo entry on pointer-down (not per move event).

### Undo / redo
`past` and `future` are arrays of `JSON.stringify(objects)` snapshots; `past` is capped at 50. Any committing action pushes the current snapshot to `past` and clears `future`. Committing actions: drag start (move/resize/rotate), font/weight/colour changes, background colour, artwork colour replace, hide, duplicate, delete, add text, reorder, center, rotate 90°. Deliberately **not** committing: typing in the "Words" field, dragging the size number (they'd flood the stack).

### Toolbar actions
- **Center** — `x = (380 − w)/2`, `y = (380 − h)/2`; no-op for background.
- **90°** — `rot = (rot + 90) % 360`; no-op for background.
- **Export** — builds the SVG string, stores it as pending, opens the rating modal.

### Layer actions
- **Hide** toggles `hidden`; hidden objects are excluded from export.
- **Duplicate** inserts a copy directly above the original with `" copy"` appended to the name, offset +16/+16, a fresh id, and selects it.
- **Delete** removes the object and falls the selection back to the background; the background itself cannot be deleted.
- **Add text** appends a new text layer (`x:90, y:150, w:200, h:48`, "Your text", Arial 34/700, `#111111`) and selects it.
- **Reorder** by HTML drag-and-drop between rows; remember the display list is reversed.

### Export (SVG generation)
Serialises to a `380 × 380` SVG with matching `viewBox`. Hidden objects are skipped. Background → a full-bleed `<rect>`. Every other object is wrapped in `<g transform="rotate(rot cx cy)">` where `cx = x + w/2, cy = y + h/2`.
- **Text** → `<text>` at the centre with `text-anchor="middle" dominant-baseline="central"`, carrying font-family/size/weight/fill. Text content must be escaped for `<`, `>`, `&`.
- **Artwork** → each shape converted from percentage to absolute board coordinates: `X = x + shape.x/100 × w` (same for Y/W/H). Circles emit `<ellipse>`, rects emit `<rect>` with `rx` scaled from the shape's radius.
Download is a `Blob` of type `image/svg+xml` → object URL → synthetic `<a download="RocketJet-logo.svg">` click → revoke after 2s. **This only runs from "Send rating & download".**

### Hover / focus states
- Ghost/row buttons hover to `#f2f4f7`.
- Inputs and selects on focus: border `#5b6cff` + `0 0 0 3px rgba(91,108,255,.15)`, no default outline.
- Stars scale and fill on hover as described.
- Links: `#5b6cff`, hover `#4453d6`.

### Responsive
The prototype is desktop-only: fixed 380px board, floating panels pinned to viewport corners. Decide your own breakpoint behaviour — the obvious approach is to dock the inspector and layers panels into sheets below ~900px.

---

## State Management

Single component state object:

| Key | Type | Purpose |
| --- | --- | --- |
| `objects` | array | The document — ordered back-to-front (index 0 is the background) |
| `selectedId` | string \| null | Currently selected object id |
| `past` / `future` | string[] | Undo / redo snapshot stacks (JSON of `objects`, max 50) |
| `devOpen` | boolean | Dev rail expanded |
| `rateOpen` | boolean | Export rating modal open |
| `rating` | 0–5 | Chosen star rating (0 = none) |
| `hoverStar` | 0–5 | Transient hover preview |
| `reasonsOpen` | boolean | Cancellation reasons modal open |
| `reasons` | string[] | Selected cancellation reasons |
| `other` | string | Free-text cancellation note |
| `aiOpen` | boolean | Unlock-AI overlay open |

Non-state instance fields: `drag` (active drag descriptor), `pendingSvg` (the generated but not-yet-downloaded SVG string), `nextId` (id counter), `dragFrom` (layer drag source index).

### Object model
```js
// background
{ id:'bg',  type:'bg',   name:'Background', color:'#ffffff', hidden:false }

// artwork (non-text vector layer)
{ id:'art', type:'art',  name:'Logo mark', x:134, y:60, w:112, h:112, rot:0,
  hidden:false, colors:['#dfe6ef','#5b6cff','#f2802e'] }

// text
{ id:'t1',  type:'text', name:'Text', x:50, y:212, w:280, h:56, rot:0, hidden:false,
  text:'RocketJet', font:'Arial', size:40, weight:800, color:'#1f6fd6' }
```

### Artwork model (important for find & replace)
The artwork carries a **palette** (`colors`) and a **shape list** that references palette *indices* (`ci`). Geometry is in percentages of the object box, so shapes scale with resize. In the prototype the shape list is a module-level constant standing in for a parsed SVG:

```js
const ART_SHAPES = [
  { t:'rect',   x:0,  y:0,  w:100, h:100, r:14, ci:0 },
  { t:'circle', x:13, y:11, w:38,  h:38,        ci:1 },
  { t:'circle', x:57, y:19, w:24,  h:24,        ci:1 },
  { t:'rect',   x:15, y:65, w:62,  h:17,  r:6,  ci:2 },
];
```

Two shapes share `ci:1` on purpose — it demonstrates that replacing one palette entry recolours **every** shape using it. **In production, replace this constant with a real parse of the imported SVG**: walk the document, collect the unique set of `fill`/`stroke` values into the palette, and rewrite each node to reference its palette entry. Find-and-replace then becomes "set palette[i] = newColour" and re-serialise.

### Backend hooks to add
- `POST` export rating (`{rating, assetId}`) on "Send rating & download".
- `POST` abandonment feedback (`{rating:1, reasons[], other, assetId}`) on "Abandon & send".
- Entitlement check for AI features (drives the pill and overlay); billing redirect from "Upgrade to unlock".
- Real asset loading in place of the dev rail's sample list.

---

## Design Tokens

### Colours
| Role | Hex |
| --- | --- |
| App background | `#eef0f3` |
| Surface / panels | `#ffffff` |
| Primary text | `#1b1f24` |
| Body text | `#374151` |
| Secondary text | `#4b5563` |
| Muted text | `#6b7280` |
| Faint text / icons | `#9aa1ab` |
| Disabled text/icon | `#c3c9d2`, `#d3d7dd`, `#b6bcc6` |
| Accent (primary) | `#5b6cff` |
| Accent hover (links) | `#4453d6` |
| Accent gradient (AI) | `linear-gradient(90deg,#5b6cff,#8f6bff)` |
| Accent tint background | `#eef0ff` / `#f4f6ff` |
| Accent tint border | `#d7dcff` |
| Accent focus ring | `rgba(91,108,255,.15)` |
| Border (panel) | `#e6e8eb` |
| Border (input) | `#d7dbe1` |
| Border (subtle row) | `#eceef2` |
| Row hover | `#f2f4f7` |
| Danger | `#e0575b` (border/fill), `#c94146` (text), `#fff5f5` (bg), `#f7d7d8` (border), `#8a3d40` (text on tint) |
| Star filled / dev accent | `#f2b03e` |
| Star empty | `#dfe3e9` |
| Dev surface | `#181b20`, `#22262e`; dev text `#c8ccd4`, `#9aa0ab`, `#7c828e`, `#5b616d` |
| Modal backdrop | `rgba(16,19,24,.42)` rating / `.46` AI / `.5` reasons |

Text swatch palette: `#1f6fd6`, `#f2802e`, `#111111`, `#12b76a`, `#e0575b`, `#8f6bff`
Background palette: `#ffffff`, `#111111`, `#eef0f3`, `#fff4e6`, `#0b2a4a`
Default artwork palette: `#dfe6ef`, `#5b6cff`, `#f2802e`

### Typography
System stack: `-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`, with `-webkit-font-smoothing:antialiased`. Monospace (`ui-monospace, monospace`) for hex values and the size badge.

| Use | Size / weight |
| --- | --- |
| Modal title | 15px / 700 |
| Filename, panel title | 13px / 600, 12.5px / 700 |
| Body, inputs, layer names | 13px / 400 |
| Buttons, secondary copy | 12.5px |
| Field labels, helper copy | 11–12px |
| Section labels (caps) | 9–10px / 700, letter-spacing .5–.6px |
| Hex values, size badge | 10–11px monospace |
| Stars | 29px |

### Spacing
Panel padding 12–14px (modals 20–22px); gaps 2 / 4 / 6 / 7 / 8 / 9 / 10 / 11px; panels inset 16px from the viewport edges; toolbar sits at y=16, inspector at y=76.

### Radii
Modals/panels 12–14 · buttons, inputs, selects 8 · rows and feature cards 9–10 · swatches, handles, app chip 6 · checkbox 5 · size badge 4 · rotate handle 50%.

### Shadows
| Token | Value |
| --- | --- |
| Board | `0 16px 44px rgba(0,0,0,.16)` |
| Toolbar | `0 10px 30px rgba(0,0,0,.12)` |
| Inspector | `0 16px 40px rgba(0,0,0,.15)` |
| Layers | `0 10px 30px rgba(0,0,0,.14)` |
| Dev panel / pill | `0 10px 30px rgba(0,0,0,.28)` / `0 6px 18px rgba(0,0,0,.25)` |
| Modal | `0 24px 60px rgba(0,0,0,.28–.3)` |
| AI pill | `0 10px 26px rgba(91,108,255,.35)` |
| Handles | `0 2px 6px rgba(0,0,0,.12–.18)` |

---

## Assets
None. All iconography in the prototype is Unicode glyphs (`◆ ⟳ ✥ ⤢ ⠿ ◉ ○ ⧉ ✕ ✦ ✎ ★ ✓ ↶ ↷ ↓ ⚙ 🅣 ▨`) used as stand-ins — **swap these for your icon set** (Lucide equivalents: diamond, rotate-cw, move, maximize-2, grip-vertical, eye/eye-off, copy, x, sparkles, pencil, star, check, undo-2, redo-2, download, settings, type, image). The artwork is the placeholder shape composition described above; no images or fonts are loaded.

## Files
- `RocketJet Editor.dc.html` — the complete working prototype (markup at the top, logic class in the `<script data-dc-script>` block at the bottom). Open it in a browser to interact.
