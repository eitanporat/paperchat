# Subagent brief — read this FIRST, ignore everything else

You are writing ONE HTML fragment file. This file is the only thing you
produce. Everything you need is in this brief.

## Task in one sentence

Read this brief → write `sections/<your-id>.html` covering the concepts
you were given → done.

## Output: ONE file at `sections/<your-id>.html`

It's an HTML fragment, NOT a page. NO `<html>`, NO `<head>`, NO `<body>`,
NO `<section>`. Wrap content in `<div class="pc-prose pc-stagger">`. The
parent injects this into a `<section class="pc-page">` placeholder.

## Template — copy this, then customize

```html
<div class="pc-prose pc-stagger">
  <div class="pc-eyebrow pc-fade-in">Section 2.3</div>
  <div class="pc-source pc-fade-in" data-page="40">pp. 40–42</div>
  <p class="pc-fade-in">
    Opening paragraph orients the reader: what is this idea, why does the chapter introduce it here, what do they already need to know.
  </p>

  <p class="pc-fade-in">
    Second paragraph builds on the first. Use <strong>bold</strong> for
    real emphasis, <em>italics</em> for terminology being introduced.
    Math via KaTeX: $E = mc^2$ inline, $$F = ma$$ display.
  </p>

  <figure class="pc-figure pc-rise">
    <img src="figures/img-040-002.jpg" alt="electron orbitals">
    <figcaption><strong>Fig 2.3</strong> Orbital shapes for s, p, d.</figcaption>
  </figure>

  <div class="pc-callout pc-fade-in">
    <div class="pc-callout-title">Key idea</div>
    A one-line takeaway worth pulling out.
  </div>

  <details class="pc-skip">
    <summary>Skipped: detailed derivation of the Schrödinger equation</summary>
    Optional further detail goes here.
  </details>
</div>
```

## Image paths — critical

Your fragment is **injected into `index.html` via JS**, so relative URLs
resolve against `index.html`, NOT against `sections/<id>.html`.

- USE: `<img src="figures/img-040-002.jpg">`
- DO NOT USE: `<img src="../figures/...">` (breaks)
- DO NOT USE: full paths starting with `/`

The planner has already reviewed every figure it assigned to you and
confirmed it matches its caption. Trust the assignment — embed exactly
the figures it listed, with the captions it wrote. If you want a
different figure or a crop, recreate it inline as SVG/Canvas instead;
don't go figure-shopping yourself.

## Class vocabulary — use ONLY these

    .pc-prose          prose container (you start with this)
    .pc-eyebrow        mono uppercase label above headings
    .pc-source         source-page citation (e.g. "pp. 40–42")
    .pc-figure         figure wrapper
    .pc-figure--zoom   click-to-enlarge
    .pc-fig-interactive  host for an interactive figure
    .pc-callout        pulled-out tip / definition
    .pc-callout--alt   orange variant (rare)
    .pc-skip           collapsible details block

No `.card`. No ad-hoc colors. Use `var(--accent)`, `var(--ink-soft)` etc.

## Defining terms inline — use pc-term

Every technical term should be defined on its FIRST appearance. The
nicest way: wrap it in `<pc-term def="…">…</pc-term>` so the
definition shows on hover/focus without breaking the prose flow.

    The smallest repeating 3D building block is the
    <pc-term def="The minimum 3D block whose translation tiles the
    whole crystal.">unit cell</pc-term>.

Use it for:
- Every technical term on first appearance.
- Acronyms (PSP, APF, BCC) — `<pc-term def="Atomic packing factor —
  the fraction of unit-cell volume occupied by atom hard spheres.">APF</pc-term>`.
- Re-uses where the reader might have forgotten the meaning.

The `def` attribute is plain HTML and may contain inline KaTeX
(`$x^2$`). Keep definitions short — 1–2 sentences. For deeper
context, link to the section or leave it in the body prose.

Don't wrap the same term every time it appears — once on first use
is the rule. If you've used `pc-term` for "unit cell" in the
orientation paragraph, just say "unit cell" in later paragraphs.

## Review cards at the end of every section

Every section should end with a `<pc-anki>` deck of review cards so
the reader can self-test the key concepts before moving on. You
decide how many — short sections might warrant just a few cards,
dense ones more. The right count is "enough to cover the
load-bearing ideas, not so many that you're padding."

Place AFTER the callout, BEFORE any optional `<details class="pc-skip">`:

    <pc-anki>
      <script type="application/json">
        [
          {"q": "What is X?", "a": "X is …"},
          {"q": "When does Y happen?", "a": "Y happens when … because …"},
          {"q": "Compute Z for FCC copper.", "a": "$\\rho = nA / (V_C N_A)$; with $n=4, A=63.5, …$ → $\\rho \\approx 8.94$ g/cm³"}
        ]
      </script>
    </pc-anki>

Rules:
- Each card is ONE testable fact, definition, formula, or worked
  example — not "tell me everything about X."
- Mix card types: definitions, comparisons ("difference between X
  and Y"), computations ("predict Z for these values"), reasoning
  ("why does W happen?"), and trap-spotters ("what's wrong with
  saying X?").
- KaTeX in `q` or `a` is fine — use `$...$` delimiters.
- Use the `<script type="application/json">` form (not the `data=…`
  attr) — answers often have apostrophes and longer prose.
- Don't repeat phrasing from the section body; the cards should be
  fresh quiz prompts the reader hasn't seen verbatim.

## Source-page citation

Every section should surface which pages of the original book it
summarizes so the reader can flip back; clicking jumps the PDF
viewer to that page. Use the `.pc-source` class right under the
`.pc-eyebrow`:

    <div class="pc-source pc-fade-in" data-page="40">pp. 40–42</div>

- `data-page` is the FIRST PDF page (absolute page number, 1-indexed
  — same as `source_pages[0]` from plan.json). The chapter-site
  click handler reads this attribute and posts a message to the
  paperchat parent app, which closes the overlay and scrolls the
  PDF viewer to that page.
- Visible text formats: single page → `p. 41`; range → `pp. 40–42`
  (en-dash, not hyphen); discontiguous → `pp. 38, 41–42`.
- Match what the planner gave you in `source_pages`. Don't bury
  this in a callout or footnote — it's a top-of-section citation.

## Animation classes — apply liberally

Every element should have one:

    .pc-fade-in   subtle 8px rise on enter (default for paragraphs)
    .pc-rise      stronger 16px rise (use on headings, figures)
    .pc-draw      on an SVG <path> — strokes itself in

Parent's wrapper has `.pc-stagger` so your children animate in sequence.

## Default to interactivity. Prose is the last resort.

If a concept can be explained interactively — by letting the reader
click through a sequence, drag a parameter, toggle states, hover for
a definition, switch between options, scroll through a sortable
table, expand a tree, walk an annotated diagram — then **do that
instead of writing it out as a paragraph**. A draggable slider that
shows force-vs-separation as the reader moves r teaches more in 5
seconds than 100 words of "as r decreases, the repulsive term
grows…" The reader retains it because they discovered it.

Hierarchy of preference for any chunk of explanation:

1. **Direct interaction** — the reader manipulates a parameter, a
   state, a position, a selection (pc-slider, pc-toggle, pc-stepped,
   pc-annotated, pc-tree, or a custom web component with click/drag).
2. **Layered reveal** — definitions inline (pc-term hover), details
   on click (pc-chain, pc-equation, pc-grid).
3. **Static figure with caption** — diagram, table, equation.
4. **Prose paragraph** — only when 1–3 wouldn't naturally fit.

Examples of "convert this prose to interactive":

- "There are 7 crystal systems with these axes/angles…" → **pc-grid**
  of 7 cards, click for the example mineral and a small SVG unit cell.
- "The Aufbau order is 1s, 2s, 2p, 3s, 3p, 4s, 3d…" → **pc-stepped**
  walking through electron-by-electron filling for a chosen Z.
- "Ionic bonds form when ΔX is large…" → **pc-slider** over ΔX
  reporting "% ionic character" via the Pauling formula.
- "Materials fall into 4 classes…" → **pc-tree** with click-to-expand.
- "Avogadro's number is 6.022e23…" → wrap in **pc-term** on first use
  so hover shows the definition.
- "Here are 5 elements and their electron configs…" → small sortable
  table or **pc-grid** (more compact than 5 paragraphs).

Don't force interactivity onto purely linear narrative (a historical
intro, a definition that's just a definition). But for any concept
that has parameters, choices, sequence, structure, or comparison —
the default answer is "interactive figure," not "explanatory paragraph."

## Interactive figures — use the pc-* web component library

`_lib/pc.js` registers 10 custom elements for the most common figure
patterns. You write ONE tag with a JSON `data` attribute; the component
handles SVG geometry, theming, animation, and click wiring. NO inline
SVG, NO `<script>` block, NO IIFE. See `_lib/ref/components.html` for
a real working example of each.

    pc-chain      process / derivation chain (A → B → C, click for detail)
    pc-stepped    walk through one step at a time (prev / next)
    pc-timeline   events on a horizontal time axis, click for context
    pc-grid       N-way comparison cards in a responsive grid
    pc-toggle     A / B state switch with per-state body
    pc-slider     parametric exploration; `formula` is a JS expr in `x`
    pc-plot       line / bar / scatter from {series:[{points:[[x,y],…]}]}
    pc-annotated  image + numbered hotspots that reveal labels
    pc-equation   KaTeX equation + clickable symbol legend
    pc-tree       hierarchical content as nested collapsible cards
    pc-term       inline term with hover/focus tooltip definition
    pc-anki       Anki-style review-card deck (END of every section)

Minimum usage — pick the closest component, fill in the JSON:

    <pc-chain data='[
      {"label":"…", "sub":"…", "detail":"…"},
      ...
    ]'></pc-chain>

### JSON payload: default to `<script type="application/json">`

The `data='...'` attribute is fragile. Two failure modes that have
broken real chapters:

  1. **Apostrophes inside JSON strings** (`Hund's rule`, `don't`,
     `Avogadro's number`) close the HTML attribute → JSON gets
     truncated → component shows its empty-data placeholder.
  2. **Mistyping `"` as `'`** (e.g. ending a string with `})()'`
     instead of `})()"`) — this happens most often in `pc-slider`'s
     `formula` field, which mixes JS code with JSON quoting and is
     easy to slip on. JSON parser sees an unterminated string and
     trips on the next newline.

Every `pc-*` component also accepts a child
`<script type="application/json">` payload. Script content bypasses
HTML attribute quoting entirely — neither single nor double quotes
need escaping, and a missing closing quote fails noisily rather than
silently consuming the rest of the file. **Default to this form for
ANY payload longer than a few values, ANY payload with prose, and
ALWAYS for `pc-slider` formulas.**

    <pc-stepped>
      <script type="application/json">
        [
          {"title": "Hund's rule", "body": "Electrons fill empty orbitals before pairing — Hund's rule says..."},
          {"title": "Pauli exclusion", "body": "No two electrons share all four quantum numbers."}
        ]
      </script>
    </pc-stepped>

Use `data='[...]'` only for very short, apostrophe-free payloads
where the inline form genuinely reads better (a 3-cell `pc-grid`
with one-word labels, say).

Pick the closest match for the cognitive primitive ("compare", "walk
through", "explore parameter", …) — not for the subject. A chemistry
"derivation chain" and a calculus "function composition" both want
`pc-chain`. Subject-specific styling is the component's job.

### Custom interactive figures — encouraged for chapter-specific concepts

The pc-* library handles the 10 most common patterns. Use it when one
fits. But many chapters have a uniquely visual concept that NO generic
component captures well — and those deserve a bespoke interactive figure
that makes the idea click. Examples that should be custom, not pc-*:

  - electron shells around a nucleus (click to add/remove electrons, switch element)
  - wave interference patterns (slider over wavelength + 2 slits, see fringes shift)
  - phase diagram with a draggable (T, P) cursor that reports the phase
  - Fourier series builder (toggle harmonics on/off, watch the sum approach a square wave)
  - a vector field you can sample by moving the mouse
  - a fractal explorer with a zoom slider
  - an interactive Punnett square or genome browser
  - a Bohr → wave-mechanical model morph
  - a draggable lever / pulley / spring system

When the concept has STRUCTURE the user can manipulate (an angle, a
parameter, a state, a position), build a custom figure. Don't shoehorn
it into pc-grid or pc-stepped if those would flatten what makes it
interesting.

**Wrap custom figures as a one-off web component inside the section:**

    <atom-shells data='{"element":"C","Z":6,"shells":[2,4]}'></atom-shells>
    <script>
      class AtomShells extends HTMLElement {
        connectedCallback() {
          const d = JSON.parse(this.getAttribute('data') || '{}');
          // render nucleus + shells + electrons as SVG
          // wire click handlers to add/remove electrons, swap elements
          this.innerHTML = `<figure class="pc-fig-interactive pc-rise">…</figure>`;
        }
      }
      customElements.define('atom-shells', AtomShells);
    </script>

Why the web-component wrapper (vs raw inline SVG + IIFE):
- Self-contained — one element, one class, one place to debug.
- If something throws in `connectedCallback`, the rest of the page
  still renders (vs an IIFE error killing other scripts).
- Reads cleaner — the JSON makes intent obvious.
- You can reuse it: drop a second `<atom-shells data=…>` elsewhere
  in the section with different data; same code handles both.

**Verify the physics/math before shipping.** If your custom figure
computes anything (forces, energies, probabilities, rates), check
the formulas against the textbook at the obvious boundary points:

- For a force-vs-separation curve: at the equilibrium r₀, F_N must
  be EXACTLY zero. Solve F=0 to find r₀; don't reuse some other
  derivative.
- For a potential-energy curve: F = −dV/dr. At r₀, V is a MINIMUM
  (negative — the bound-state energy −E₀); V should approach 0 from
  below as r → ∞. If your V comes out positive at the minimum, your
  integration sign is wrong.
- For a probability density: it must be non-negative everywhere and
  integrate to 1 over the domain.
- For an angular variable that wraps: make sure your formula handles
  the wrap (mod 2π or mod 360°), not just the principal branch.

These are sanity checks, not full proofs. A figure with wrong-sign
energy or non-zero force at the labeled equilibrium teaches the
reader the wrong physics — worse than no figure.

Rules for custom figures (same as the SVG/JS pitfalls below):
- Inline `style="fill: var(--accent)"` — never bare `fill="var(--…)"`.
- Set explicit `viewBox` + cap width via `style="width:100%; max-width:…"`.
- Render once after wiring listeners (`el.addEventListener('input', render); render();`).
- Use `var(--accent)` and `var(--ink-soft)` etc., not hardcoded hex.

Be creative. The library is the floor, not the ceiling. NEVER
re-implement what a pc-* already does — but DO build something custom
when the chapter's concept deserves it.

## SVG pitfalls — re-read this before drawing ANY SVG

- **CSS variables don't work in SVG presentation attributes.**
  `fill="var(--accent-soft)"` is INVALID — SVG parses presentation
  attributes as raw color/length values, not as CSS expressions.
  Result: the element renders as the SVG default (black for fill,
  none for stroke) and the soft-paper theming is lost. Use one of:
  - inline style: `style="fill: var(--accent-soft); stroke: var(--ink)"`
  - or hardcode the hex from `_lib/pc.css` (`--accent: #c25b2a`, etc.)
  - or use `fill="currentColor"` and let the parent's CSS color win.
  Same rule for `font-family="var(--mono)"` (invalid) and any other
  `attr="var(--…)"` pattern.
- **Coordinate sanity.** Set `viewBox="0 0 W H"` and place every
  element inside that box. Off-by-one or wrong-scale geometry is the
  #1 cause of "figure looks wrong" — sketch the layout on paper
  first if it's non-trivial.
- **Text alignment.** SVG `<text>` `y` is the BASELINE, not the top.
  For visually-centered text inside a row of height H starting at y0,
  use `y = y0 + H * 0.7` (or use `dominant-baseline="middle"` and
  `y = y0 + H/2`).
- **Stroke vs fill on `<path>`/`<line>`/`<rect>`.** A `<path>` with
  only `d="..."` and no `fill`/`stroke` renders as a solid BLACK
  filled shape (default fill is black). For diagram strokes, set
  `fill="none" stroke="<color>" stroke-width="..."`.
- **Don't put `<style>` blocks inside `<svg>` without scoping.** A
  rule like `circle { fill: red }` inside an SVG affects every other
  SVG on the page too. Use inline styles or scope to an id.

## JS pitfalls — if you write `<script>`, re-read this

- Object literal property assignment is `:` not `=`. `{a:1, b=2}` is a
  SyntaxError that kills the whole script tag.
- `tr.rowIndex` is whole-table index, NOT tbody-only. Use
  `for (let i = 0; i < tbody.rows.length; i++)`.
- Multiple IIFEs in ONE `<script>` share fate — one throws, others die.
  Split into separate `<script>` tags.
- Put each `<script>` AFTER the markup it manipulates.
- Call your render function ONCE after wiring listeners:
  `slider.oninput = render; render();`
- `<canvas>` defaults to 300×150. Set both `width`/`height` attrs AND a
  matching `style="width:…;height:…"` or you get blurry output.

## Math (KaTeX) — what works, what breaks

- Inline: `$E = mc^2$` (single `$`). Display: `$$\bar{A} = \sum_i f_i A_i$$`.
- The site renders math AFTER your section is injected into the DOM,
  so your math just needs to be valid LaTeX inside `$…$`. Don't escape
  the dollars; don't wrap math in `<code>`/`<pre>` (KaTeX skips those).
- Subscripts and superscripts MUST come from the math grammar, not
  from HTML: write `$x^2$` not `<sup>2</sup>`, write `$O_2$` not
  `O<sub>2</sub>`.
- HTML entities like `&ell;` inside `<text>` SVG won't render as
  math italic. If you need a real Greek letter inside an SVG label,
  use the actual Unicode codepoint (`ℓ`, `ψ`, `λ`) — they're already
  in the right font.

## Audience + length

Write for someone meeting this material for the FIRST TIME, not a
review reader. The job is to actually teach the concept — to make it
click — not just to list facts.

**Shortness matters.** The site exists because reading the original
chapter takes too long; a bloated summary wastes the reason for the
summary. Always shorter than the book.

No word target. You decide the length by what the concept needs:
short enough that nothing is filler, long enough that every term is
defined on first use, every formula is built step by step, and at
least one worked example lands. If you find yourself padding to
sound thorough, cut. If you find yourself dropping definitions to
sound terse, expand. Trust your judgment per section — what's
right for a one-paragraph aside in the book is different from what's
right for a multi-page derivation.

Structural backbone for every section:

1. **Orientation.** What is this idea? Why does the chapter introduce
   it here? What does the reader already need to know to follow it?
   (Brief anchors back to earlier sections when relevant.)
2. **The core development.** Define each term as you introduce it.
   Build any formula up step by step (don't drop it whole); say what
   each variable means and what it does to the result. State
   assumptions explicitly.
3. **A worked example or named case — when it helps.** Highly
   recommended for quantitative concepts ("FCC copper, R = 0.128 nm,
   A = 63.5 g/mol → ρ ≈ 8.94 g/cm³"), comparative concepts (a named
   specific instance with concrete properties), and anything the
   reader will need to recognize in practice. Skip it when the
   section is an overview, a definition, a historical aside, or
   anything where a concrete example would feel forced. Your call.
4. **Why-it-matters callout (`pc-callout`).** One- or two-sentence
   pull-quote that names the consequence — "APF distinguishes
   structures that look similar geometrically but behave totally
   differently mechanically," not "APF is important."
5. **Optionally: a contrast or edge case in `<details class="pc-skip">`.**
   Cases where the rule breaks (polymorphism, allotropy, glasses vs
   crystals). The reader can choose to dig in.

Worked examples are powerful when the concept has one to give, but
forcing one onto a section that doesn't need it is worse than
leaving it out. Use judgment.

## What "done" looks like

A pedagogical fragment that:
- Follows the structural backbone (orient → develop → optional
  example → callout → optional skip), adapting as the concept needs.
- Defines every technical term on first use.
- Walks through any formula step by step.
- Includes a worked example or named case where it would teach;
  skips it where it would feel forced.
- Wraps content in `<div class="pc-prose pc-stagger">`; uses
  animation classes on every visible child (`.pc-fade-in` /
  `.pc-rise` / `.pc-draw`).
- Uses one interactive figure when the concept has manipulable
  structure (parameter, state, position); skip the figure for purely
  textual ideas.
- Throws no console errors.

Don't ask the parent for clarification. Don't write anything outside the
file. When done, just exit.
