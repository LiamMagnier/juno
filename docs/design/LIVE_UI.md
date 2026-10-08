# Live UI

Interactive components inline in a chat answer, on the web and in the Mac and
iOS apps. Alevr's answer to GPT-6 "Intelligent UI" (Oct 2026): instead of a
paragraph about how the tip changes the split, the reply carries the split,
with the tip on a slider.

Live UI is for lightweight, declarative views that live inside a message.
Full apps and games stay in Canvas artifacts (sandboxed HTML/React), and
lessons stay in the `:::` learning blocks. Live UI never runs code.

## 1. The block

One fenced block, info string `live-ui` (aliases `live`, `juno-live`), body JSON:

````
```live-ui
{"title":"Split the bill","currency":"EUR",
 "data":{"items":[{"name":"Margherita","price":14.5},{"name":"Carbonara","price":17}]},
 "let":{"subtotal":"sum(items.price)","total":"subtotal*(1+tip)","each":"total/people"},
 "ui":[
  {"type":"row","children":[
    {"type":"slider","id":"tip","label":"Tip","min":0,"max":0.25,"step":0.01,"value":0.1,"format":"percent"},
    {"type":"stepper","id":"people","label":"People","min":1,"max":12,"value":2}]},
  {"type":"metric","label":"Each pays","value":"each","format":"currency"}]}
```
````

Why a fenced JSON block, not `:::live` YAML:

- **Streams well.** A fenced block is already one unit in both markdown
  pipelines (web `splitIntoBlocks`, native `JunoMarkdown.blocks`), and a
  tolerant JSON reader can return everything that has fully arrived. YAML's
  indentation makes "is this list item finished?" a guess.
- **Models emit it reliably.** Every frontier model is drilled on JSON; nested
  YAML with expressions containing `:` and `?` is where they slip.
- **Native gets it for free.** Swift has no YAML reader for a nested tree; the
  tolerant reader is ~150 lines in each language and held to the same fixtures.

Key order is part of the contract: `title`, `currency`, `data`, `let`, `ui`.
Formulas arrive before the components that show them, so a streaming view
never displays a metric whose formula has not arrived yet.

## 2. Components

Every component is `{"type": …}`. Inputs carry `id`, `label`, `value` (default).

| Group   | type        | fields |
|---------|-------------|--------|
| Layout  | `row`       | `children` (wraps to a column at narrow width) |
|         | `grid`      | `columns` 2–4, `children` |
|         | `section`   | `title?`, `children` |
| Input   | `slider`    | `min`, `max`, `step`, `format?`, `unit?` |
|         | `number`    | `min?`, `max?`, `step?`, `format?`, `unit?` |
|         | `stepper`   | `min`, `max`, `step?` |
|         | `select`    | `options` (strings, numbers or `{label,value}`), `style?` `segmented`/`menu` |
|         | `toggle`    | boolean `value` |
|         | `date`      | `value` `YYYY-MM-DD` |
|         | `input`     | text `value`, `placeholder?` |
| Output  | `metric`    | `label`, `value` (expr), `format?`, `unit?`, `hint?` (text), `emphasis?` |
|         | `text`      | `text` with `{{expr}}` and `**bold**`, `tone?` `muted` |
|         | `progress`  | `label`, `value` (expr), `max?` (expr, default 1), `format?` |
|         | `chart`     | `kind` line/area/bar; either `x:{from,to,step,var?,label?}` + `series:[{label,y}]` (y sees `x`), or `rows` (expr) + `xKey` (expr per row) + `series` (y per row); `format?`; `mark?` (an x to rule and rest the readout on; an area chart shades up to it) |
|         | `table`     | `rows` (expr), `columns:[{label,value,format?}]` (value sees the row's fields) |
|         | `explorer`  | `parts:[{id,label,summary?,detail,facts?:[{label,value}],at?:[x,y]}]`, `links?:[[a,b]]` |
|         | `stops`     | `stops:[{name,time?,note?,query?}]` |
|         | `checklist` | `id`, `items` (strings or `{label,note?}`) |
| Action  | `button`    | `label`, and `prompt` (text with `{{expr}}`, sent as the user's next message) or `copy` (expr) |

`format`: `number`, `integer`, `currency`, `percent`, `compact`, `date`.
**Percent values are fractions** (0.12 shows as 12%), the spreadsheet rule the
semantic artifacts already use. `unit` is a plain suffix ("km", "kg").

Explorer covers the "click into the bike" case: with `at` (0–100 coordinates)
the parts become hotspots on a schematic, joined by `links`; without `at` they
are a list. Selecting a part reveals its detail and facts. Stops render an
ordered route with "Open in Maps" per stop and a whole-route link; the only
URLs ever built are Apple Maps and Google Maps search/directions from the
stop text, never a URL from the model.

## 3. Expressions

A small, safe language with identical semantics in TypeScript
(`src/lib/live-ui/expr.ts`) and Swift (`JunoLiveUIExpression.swift`), held to
the shared fixtures in `contracts/live-ui/fixtures/*.json`.

- Literals: numbers, `'single'` or `"double"` strings, `true`, `false`, `null`, `[a, b]`.
- Names: input ids, `let` names, `data` keys, row fields (tables, row charts),
  the chart variable (`x` by default), constants `pi` and `e`.
- Operators, by precedence: `?:`, `||`, `&&`, `== !=`, `< <= > >=`, `+ -`,
  `* / %`, unary `- ! +`, `^` (right-assoc), then `.field`, `[index]`, calls.
- `list.field` plucks; `+ - * / % ^` on lists are element-wise (list with
  scalar, or two lists of equal length).
- `+` with a string concatenates; numbers convert with the canonical
  number-to-string (integers plain, else up to 10 decimals, zeros trimmed).
- Truthiness: `false`, `null`, `0`, `""`, `[]` are false.
- Functions: `sum avg min max count len round(x,d) floor ceil abs sqrt pow exp
  ln log10 clamp(x,lo,hi) if(c,a,b) range(from,to,step) pmt(rate,n,pv)
  fv(rate,n,payment,pv) normpdf(x,mean,sd) normcdf(x,mean,sd) days(from,to)
  addDays(date,n) fmt(x,kind,digits?)`.
- `round` is half away from zero. `pmt`/`fv` return positive amounts.
  `normcdf` uses the Abramowitz–Stegun 7.1.26 erf, written identically twice.
- Errors never throw to the UI: an unknown name, a type mismatch, division by
  zero or a non-finite result yields `null`, shown as a muted dash.
- `let` entries evaluate lazily with memoisation; a cycle marks every member
  as an error ("circular") without hanging.

No `eval`, no `Function`, no property access beyond plain data fields, no
loops, no regexes, no network.

## 4. Limits (both platforms)

| What | Limit |
|------|-------|
| Block source | 24,000 characters |
| Components (all depths) | 80 |
| Layout nesting | 4 levels |
| Expression | 400 characters, 160 AST nodes, depth 32 |
| Evaluation budget | 50,000 steps per expression (list elements count) |
| `data` lists | 200 rows; `range` 500 values |
| Chart | 4 series, 400 points each |
| Table rows / explorer parts / stops / checklist / options | 100 / 24 / 25 / 40 / 12 |
| `let` entries | 40 |
| String results | 2,000 characters |

Anything over a limit is truncated (lists) or becomes an error value
(expressions); the view never stalls the transcript.

## 5. Streaming

The tolerant reader (`src/lib/live-ui/json.ts`, `JunoLiveUIJSON.swift`) parses
what has arrived and marks every object and array that has not closed. Then:

- A closed component renders. An unclosed layout renders its closed children
  and a skeleton line where the rest will go. An unclosed leaf is held back
  (a skeleton of the right height takes its place).
- A string or number still being written at the end of input is dropped, never
  shown half-typed. A `let` formula appears once its string closes.
- Raw syntax is never shown while streaming. If the finished block is not valid
  JSON at all, the view says it could not be shown and offers the source.

Web renders inside `CodeBlock` (markdown.tsx), whose component identity is
stable across deltas, so input state survives the stream. Native renders from
`JunoMarkdownBlockView` / `JunoReadingBlockView` with `streaming: !isClosed`.

## 6. State

Input values, checklist ticks and the explorer selection are local to the
message. Adjusted values persist per message: `localStorage` on the web and
`UserDefaults` on native, key `live-ui:v1:<messageId>:<hash(source)>`
(FNV-1a 32 over the block source). A Reset control appears once anything moved
from the author's defaults.

## 7. Prompt contract

`src/lib/chat/system-prompt.ts` adds a `# Live UI` section to the stable tier
when `liveUi` is on (byte-identical for every user with the same toggles, so
the cache prefix holds). It is on for the web and for native builds that
declare the `live_ui` client feature (`src/lib/chat/client-features.ts`);
shipped native builds that cannot render it never see it. Never in voice mode.

When: numbers with what-ifs, budgets, loans, savings, splitting, conversions,
comparisons where tweaking matters, exploring the parts of a system, a route
or step plan to tick off. Allowed for ANSWER and UNDERSTAND.
When not: simple facts, definitions, chit-chat, a single number with nothing to
adjust, BUILD requests (they want real code or an artifact). One view per reply
at most, always with prose that states the answer on its own.

## 8. Renderers

- Web: `src/components/chat/live-ui/*`. Rule-bounded figure like the learning
  blocks (hairlines, no card fill), two weights, accent on the slider fill and
  the emphasised metric only, no pills or status dots, keyboard operable,
  one column under 480px of container width. Charts are hand-drawn SVG (the web
  has no chart library) with a keyboard/hover crosshair readout.
- Native: `JunoDesignSystem/LiveUI/*` (`JunoLiveUIJSON`, `JunoLiveUIFormat`, `JunoLiveUIExpression`, `JunoLiveUISpec`, `JunoLiveUIView`, `JunoLiveUIParts`). Native controls (Slider, TextField with
  number formats, Stepper, Picker, Toggle, DatePicker), Swift Charts, Liquid
  Glass only on the explorer's detail card (`glassEffect`), never a fake blur.
  Prompt buttons call the `junoLiveUIHost` environment action, which the Mac
  `MessageRow` and the iOS transcript wire to their send path.

## 9. "Start answering while reasoning"

Checked the pipeline: the web already renders answer text the moment the first
answer delta lands (message-item maps `message.content` into parts on every
delta) while the reasoning timeline above it keeps streaming, and native does
the same from `NativeTurnStream`. Providers that interleave (Anthropic
interleaved thinking, OpenAI reasoning summaries) therefore already "answer
while reasoning". The remaining gap is model-side: most providers finish
reasoning before the first answer token. A cheap future improvement is to
collapse the reasoning dock to its one-line live summary as soon as the first
answer token arrives instead of when the turn finishes; that belongs to the
web-motion lane and was not changed here.

## 10. Files

- Contract and fixtures: `contracts/live-ui/fixtures/*.json`
- TS core: `src/lib/live-ui/{json,expr,format,spec,state}.ts`
- Web UI: `src/components/chat/live-ui/*`, routed from `markdown.tsx`
- Gallery: `/dev/live-ui` (samples in `contracts/live-ui/samples.json`, shared with the native snapshot test)
- Swift core + views: `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/LiveUI/*`
- Tests: `tests/live-ui.test.ts` (fixtures, streaming prefixes, safety bounds),
  `tests/live-ui-prompt.test.ts` (prompt gating, cache stability, every prompt
  example and gallery sample is a valid view), `LiveUIFixtureTests.swift` (the
  same fixtures in Swift), `LiveUISnapshotTests.swift` (offscreen PNGs when
  `JUNO_SNAPSHOT_DIR` is set)

## 11. Known gaps

- Model reliability is untested against live models from this lane: the
  contract is compact and JSON-first, so frontier models (Claude, GPT, Gemini)
  should follow it; small/local models may misuse it. The renderer degrades a
  bad block to a quiet "couldn't be shown" with its source.
- iOS prompt buttons fill the composer (as iOS follow-up chips do) rather than
  sending; the Mac and web send directly.
- Liquid Glass on the explorer card cannot be photographed offscreen; check it
  in the running app.
- Copying a whole reply copies the block's JSON with it.
