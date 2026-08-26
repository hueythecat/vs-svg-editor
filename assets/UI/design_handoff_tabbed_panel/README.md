# Component guide: floating tabbed control panel

A single floating panel that replaces a set of scattered floating editor panels. Three tabs — **Tools**, **Text**, **Layers** — share one card so only one thing is on screen at a time. Designed for an editor with a full-bleed canvas; the panel floats over the canvas at the top-right.

`Control Panel.dc.html` in this folder is an isolated, interactive reference (tab switching, swatch selection and the colour rows all work). Open it in a browser. It is a **design reference**, not production code — it uses an in-house template runtime that won't exist in your codebase. Rebuild it with your own components; the logic maps 1:1 onto a React class/function component (`state` → state, `renderVals()` → derived values, template → JSX).

---

## Shell

- `position:absolute; top:16px; right:16px` over the canvas; `width:272px`.
- `max-height:calc(100vh - 32px)`; **height follows content** — `display:flex; flex-direction:column` on the card, `flex:0 1 auto; min-height:0` on the body, so a short tab gives a short card and only overflow scrolls.
- `background:#fff`, `border:1px solid #e6e8eb`, `border-radius:12px`, `box-shadow:0 16px 40px rgba(0,0,0,.15)`, `overflow:hidden`.
- Body padding 14px, `overflow-y:auto; overflow-x:hidden` (x hidden is deliberate — it removes a stray horizontal scrollbar from full-width inputs).

## Tab bar

Folder-tab treatment, not a pill group.

- Row: `display:flex; gap:2px; padding:12px 12px 0; flex:none`; each tab `flex:1` so the three split the width evenly.
- Below the row: a 1px `#e6e8eb` divider with `margin-top:-1px`.
- **Active tab**: `background:#fff`, `border:1px solid #e6e8eb` with `border-bottom-color:#fff` (so it merges into the body), `border-radius:8px 8px 0 0`, `font-weight:700`, `color:#1b1f24`, `position:relative; z-index:1` to sit over the divider.
- **Inactive tab**: transparent background and border, `font-weight:500`, `color:#9aa1ab`.
- Both: `padding:9px 4px`, `font-size:12px`, `cursor:pointer`.

## Tab contents

### Tools
Document-level and object-level actions, in this order:
1. **File row** — 22×22 radius-6 `#5b6cff` chip (`◆`), filename 12.5px/600 with `text-overflow:ellipsis`, then undo `↶` and redo `↷` icon buttons (`#4b5563` enabled, `#d3d7dd` when the stack is empty).
2. **Export** — full-width primary button, `#5b6cff`, white, 12.5px/600, `padding:10px`, radius 8.
3. **SELECTION · {name}** section label, then two equal outlined buttons: "⤢ Center" and "⟳ Rotate 90°" (`flex:1`, white, 1px `#d7dbe1`, `#4b5563`, radius 8).
4. **FIND & REPLACE COLOURS** — one row per unique colour in the selected artwork. Row is a `<label>` wrapping a transparent full-bleed `<input type="color">`: flex, gap 10, 1px `#eceef2`, radius 9, `padding:7px 9px`; contains a 22×22 radius-6 swatch (white gets a 1px `#d7dbe1` border), the uppercase hex in 11px monospace `#4b5563`, and a `✎` affordance. When no artwork is selected, show a dashed-border hint instead. Fires on `change`, not `input`, so one pick = one undo entry.
5. **CANVAS COLOUR** — 24×24 radius-6 swatch row (gap 8, wrapping) plus a dashed 24×24 "+" tile wrapping a hidden colour input. Selected swatch: `outline:2px solid #5b6cff; outline-offset:2px`.
6. **AI upsell** — full-width row, `linear-gradient(90deg,#5b6cff,#8f6bff)`, radius 10, `padding:11px 13px`, `box-shadow:0 8px 20px rgba(91,108,255,.28)`; `✦` + "Customise with AI" 12.5px/700 white + "PRO" badge (9px/700 on `rgba(255,255,255,.28)`, radius 5).

### Text
Type properties for the selected text layer: Words (text input), Font (select), a two-column Size (number) / Weight (select) row, and a Colour swatch row with the same "+" custom tile. Ends with a full-width outlined "＋ Add text layer" button, which also stays available when nothing is selected — in that case the fields are replaced by a dashed-border hint ("Select a text layer on the canvas, or add one below.").

### Layers
"ELEMENTS · {count}" label with a `＋` add affordance, then the layer rows, **top = front** (reverse the object array for display; convert back with `arrayIndex = length - 1 - rowIndex`). Each row: drag grip `⠿` · type icon (`🅣` text / `◆` artwork / `▨` background) · name · actions (eye `◉`/`○`, duplicate `⧉`, delete `✕`). Selected row: `background:#eef0ff` + 1px `#d7dcff`; others 1px transparent. Row actions must `stopPropagation` so they don't also select. Rows are `draggable` for reorder.

## Behaviour

- **Tab state** is a single string (`'tools' | 'text' | 'layers'`).
- **Auto-follow selection**: selecting a text object switches to Text; selecting artwork or the background switches to Tools; **unless the user is on the Layers tab**, which stays put so they can work down the list. Adding a text layer switches to Text.
- Panel state is separate from document state — tab choice never enters the undo stack.

## Tokens used

| Role | Value |
| --- | --- |
| Surface | `#ffffff` |
| App ground | `#eef0f3` |
| Accent | `#5b6cff` (tint `#eef0ff`, tint border `#d7dcff`, focus ring `rgba(91,108,255,.15)`) |
| AI gradient | `linear-gradient(90deg,#5b6cff,#8f6bff)` |
| Primary text | `#1b1f24` · secondary `#4b5563` · muted `#6b7280` · faint `#9aa1ab` · disabled `#c3c9d2`/`#d3d7dd` |
| Borders | panel `#e6e8eb` · input `#d7dbe1` · subtle row `#eceef2` |
| Row hover | `#f2f4f7` |
| Danger | `#e0575b` |
| Shadow | `0 16px 40px rgba(0,0,0,.15)` |
| Radii | card 12 · tabs 8/8/0/0 · buttons & inputs 8 · rows 9 · swatches 6 |
| Type | system stack; 12.5px buttons, 13px inputs/rows, 11px labels, 10px/700 caps section labels (letter-spacing .5px), 11px monospace for hex |
| Spacing | body padding 14 · section gap 18 · control gaps 7–10 |

## States

- Inputs/selects on focus: `border-color:#5b6cff; box-shadow:0 0 0 3px rgba(91,108,255,.15)`, no default outline.
- Ghost buttons and rows hover to `#f2f4f7`.

## Icons

All glyphs here (`◆ ⤢ ⟳ ↶ ↷ ↓ ✦ ✎ ⠿ ◉ ○ ⧉ ✕ ＋ 🅣 ▨`) are Unicode stand-ins — swap for your icon set. Lucide equivalents: diamond, maximize-2, rotate-cw, undo-2, redo-2, download, sparkles, pencil, grip-vertical, eye/eye-off, copy, x, plus, type, image.
