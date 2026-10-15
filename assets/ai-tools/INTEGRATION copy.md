# Integrating "Customise" in the SVG editor

Flow: user loads an SVG into the canvas → clicks **Customise** → editor sends the SVG to the
svg-text service → service returns an **editable SVG** + a list of detected text items → editor
replaces the canvas content and shows a text-layer panel.

Files to copy into the editor (e.g. `src/textService/`):
- `useDetectText.ts` — the API call (hook): `detect(svgString) → { items, editableSvg, … }`
- `svgTextLayers.ts` — helpers to edit the returned SVG in the canvas (text, font, colour, show original, reject, save)

---

## 1. Point the editor at the service

`.env` (Expo reads `EXPO_PUBLIC_*` at build time):

```bash
# development, service running on the same machine
EXPO_PUBLIC_SVGTEXT_API=http://localhost:8010
# production, behind Caddy on the Pi5 (Caddyfile.snippet)
EXPO_PUBLIC_SVGTEXT_API=/api/text
```

In dev the browser calls port 8010 directly, so the service must allow the editor's origin:
`SVGTEXT_CORS=http://localhost:5174` (already the default in `ecosystem.config.js`; add more
origins comma-separated, e.g. the Pi5 hostname you browse from).

## 2. Keep the ORIGINAL SVG source

Send the SVG **exactly as loaded**, not a re-export from the canvas library. The service maps
detections back to path elements by document order; a re-exported SVG (e.g. `canvas.toSVG()`)
reorders/rewrites paths and loses that link. Store the source string when the file is loaded:

```ts
const [sourceSvg, setSourceSvg] = useState<string | null>(null);   // set on file open
```

If the canvas renders the SVG as real DOM (inline `<svg>`), you can also use
`new XMLSerializer().serializeToString(svgEl)` *before* any edits — but the stored source is safest.

**Layers hidden in the editor:** the service skips any element with `display="none"`,
`style="display:none"` or `visibility="hidden"`. If the editor keeps layer visibility in its
own state (not in the SVG), mark those layers in a copy of the source before sending — set
`display="none"` on the matching elements, keeping all elements in place so document order
(and the mapping back to paths) is unchanged. Don't remove them.

Same-line words ("YOUR" + "TAGLINE", "SURABAYA - EAST JAVA") are joined by the service itself,
so the editor doesn't need its own grouping for service results.

## 3. The Customise button

```tsx
import { useDetectText, DetectedItem } from "./textService/useDetectText";

const { detect, cancel, busy, error } = useDetectText();
const [textItems, setTextItems] = useState<DetectedItem[]>([]);

async function onCustomise() {
  if (!sourceSvg) return;
  const result = await detect(sourceSvg, currentFileName);
  if (!result) return;                       // error is set; show it
  loadSvgIntoCanvas(result.editableSvg);     // your existing "open SVG" path
  setTextItems(result.items);                // drives the text-layer panel
}

<Button onPress={onCustomise} disabled={busy || !sourceSvg} title={busy ? "Finding text…" : "Customise"} />
{busy && <Button onPress={cancel} title="Cancel" />}
{error && <Text style={{ color: "crimson" }}>{error}</Text>}
```

Expect **~5–15 s** per SVG (geometry < 2 s, one or two vision-model calls, font matching
~0.4 s per text item) — show a spinner and keep the button disabled while `busy`.

If nothing is found, `result.items` is empty and `editableSvg` is the original document
(plus an empty `editable-text` layer) — show "No editable text found" and keep the canvas as it was.

## 4. What comes back

```jsonc
{
  "items": [{
    "id": "t1",                       // links everything below
    "text": "IMPERIAL",               // what the model read — a pre-fill the user can correct
    "kind": "arc",                    // "line" | "arc" | "glyph"
    "geometry": { "centre": [298.8, 194.2], "radius": 207.6 },
    "bbox": [196.0, 365.3, 406.5, 426.8],
    "fill": "#b3416e", "capHeight": 26.9, "contours": 12,
    "source": "crop",                 // "fullpage" = found by the safety net -> flag for review
    "font": { "family": "Cinzel", "weight": 600, "category": "serif", "score": 0.76,
              "lowConfidence": false, "alternatives": ["Playfair Display 600", "Libre Baskerville 400"],
              "visionSuggestion": "Playfair Display" }
  }],
  "designFonts": [                    // up to 10 fonts suiting the whole design (vision model)
    { "family": "Cinzel", "weight": 600, "category": "serif",
      "reason": "classic roman capitals", "matchedInDesign": true }
  ],
  "editableSvg": "<?xml …><svg …>…</svg>",
  "rejected": [], "timing": { "total": 6.1, … }
}
```

Inside `editableSvg`, for each item `tN`:
- the original outlines are split out into `<g data-detected-id="tN" data-detected-text="…" display="none">`,
  left where they were in the layer tree (nothing deleted; layer panel still shows the real structure)
- the editable copy is `<g id="editable-tN" data-source="tN">` inside a new top-level
  `<g id="editable-text">` layer — a `<text>`, or `<text><textPath href="#arc-tN">` for arcs
- `<defs><style id="editable-fonts">@import …Google Fonts…</style>` loads the matched fonts

## 5. Text-layer panel (per item)

Use `svgTextLayers.ts` against the live `<svg>` element in the canvas:

```tsx
import { setItemText, setItemFont, setItemFill, showOriginal, rejectItem,
         parseFontChoice, serializeSvg } from "./textService/svgTextLayers";

// text box
<TextInput defaultValue={item.text} onChangeText={t => setItemText(svgEl, item.id, t)} />

// font picker: matched font first, then alternatives, then free choice
const choices = [`${item.font?.family} ${item.font?.weight}`, ...(item.font?.alternatives ?? [])];
onSelect={c => { const f = parseFontChoice(c); setItemFont(svgEl, item.id, f.family, f.weight); }}

// colour
onChange={hex => setItemFill(svgEl, item.id, hex)}

// compare / undo for one item
<Switch value={showingOriginal} onValueChange={v => showOriginal(svgEl, item.id, v)} />

// "not text" — restore outlines, drop the editable copy
<Button title="Not text" onPress={() => rejectItem(svgEl, item.id)} />
```

Flag for review in the UI when `item.font?.lowConfidence` or `item.source === "fullpage"`
(e.g. an amber dot plus "check font" / "check this is text" on the item row, not just a console log):

```tsx
const needsReview = item.font?.lowConfidence || item.source === "fullpage";
{needsReview && <Text style={{ color: "#c77700" }}>
  {item.source === "fullpage" ? "Check this is text" : "Font is a guess — pick from alternatives"}
</Text>}
```

The "Show original" switch and "Not text" button must be wired to `showOriginal` / `rejectItem`
above; after `rejectItem`, also drop the item from the panel's list
(`setTextItems(xs => xs.filter(x => x.id !== item.id))`).

**Design fonts come from a separate call.** `/detect` no longer waits for them, which makes Customise
about twice as fast. Start the suggestions alongside it (or when the font picker first opens):

```tsx
import { useDetectText, fetchDesignFonts, DesignFont } from "./textService/useDetectText";

const [designFonts, setDesignFonts] = useState<DesignFont[]>([]);
async function onCustomise() {
  if (!sourceSvg) return;
  fetchDesignFonts(sourceSvg).then(setDesignFonts);       // runs in parallel, never throws
  const result = await detect(sourceSvg, currentFileName);
  ...
}
```

(`POST /detect?fonts=1` still returns them in the same response, at the old, slower speed.)

**Using them:** `designFonts` is a "Suggested for this design" list. Use it in every
font picker (after the item's own match and alternatives) and as the default list when the user
adds new text. Load the fonts on demand with `ensureGoogleFont(f.family, f.weight)` and show
`reason` as a hint. The names come from the model and aren't checked against Google Fonts, so
if a font fails to load, drop it from the list. Tesseract mode returns `[]`.

```tsx
const suggested = result.designFonts.map(f => `${f.family} ${f.weight}`);
const choices = [...new Set([...itemChoices, ...suggested])];
```

Notes:
- `setItemText` removes the fitted `textLength`, so edited text uses natural width (the
  original length is only right for the original words).
- For arcs the characters live in `<textPath>` — the helper handles that; don't set
  `textContent` on the `<text>` element directly or the curve is lost.
- Fonts the user picks are loaded on demand (`ensureGoogleFont`).

## 6. Saving

```ts
const svgString = serializeSvg(svgEl);                                   // keep hidden originals (re-editable)
const flat = serializeSvg(svgEl, { dropHiddenOriginals: true });         // final output, originals removed
```

Hidden originals are harmless in the saved file (`display="none"`) and let the user revert later.
The editable text relies on Google Fonts being reachable where the SVG is viewed; for fully
self-contained exports, converting the text back to outlines at export time would be the next step.

## 7. Errors

| status | `error` message shown by the hook | cause |
|---|---|---|
| 502 | Text service can't reach the vision model | autossh tunnel to vs-svg down, or qwen not running |
| 415 | That file isn't a valid SVG | also: SVG declares XML entities (refused for safety) |
| 413 | SVG is too large / too complex | > 20 MB, or more than `SVGTEXT_MAX_PIECES` outline pieces |
| 422 | could not process SVG: … | unusual SVG structure — send the file over for a look |
| — | Timed out or cancelled | > 90 s, or the user pressed Cancel |

Quick checks: `curl localhost:8010/health` on the Pi5; `pm2 logs svg-text`.

## 8. Production

The feature only works where the service is reachable. Deploy it next to the editor (Pi5) with
`README.md` → `pm2 start ecosystem.config.js` (starts uvicorn on 8010 and the autossh tunnel to
vs-svg for the model), add `Caddyfile.snippet` to the site, and build the editor with
`EXPO_PUBLIC_SVGTEXT_API=/api/text` (and set `SVGTEXT_URL` to the same base if the editor's own
server proxies it). If the service is down, hide or disable the Customise option after a failed
`/health` check rather than letting it fail on click.
