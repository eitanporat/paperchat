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
    .pc-figure         figure wrapper
    .pc-figure--zoom   click-to-enlarge
    .pc-fig-interactive  host for an interactive figure
    .pc-callout        pulled-out tip / definition
    .pc-callout--alt   orange variant (rare)
    .pc-skip           collapsible details block

No `.card`. No ad-hoc colors. Use `var(--accent)`, `var(--ink-soft)` etc.

## Animation classes — apply liberally

Every element should have one:

    .pc-fade-in   subtle 8px rise on enter (default for paragraphs)
    .pc-rise      stronger 16px rise (use on headings, figures)
    .pc-draw      on an SVG <path> — strokes itself in

Parent's wrapper has `.pc-stagger` so your children animate in sequence.

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
    pc-tree       hierarchical node-link (taxonomy, decision tree, …)

Minimum usage — pick the closest component, fill in the JSON:

    <pc-chain data='[
      {"label":"…", "sub":"…", "detail":"…"},
      ...
    ]'></pc-chain>

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

**Length scales with the source.** Aim for roughly half to two-thirds
of the source section's word count. A 4-page textbook section that's
~2000 words → ~1000–1300 words. A short 1-page section → ~250–400
words. Always shorter than the book (it's a summary), but long enough
to define every term, develop any formula step by step, and include
at least one worked example. If the section in the source is a stub,
your summary is a stub; if the source is dense and elaborate, your
summary still earns its space — just compress, don't re-pad.

The planner's per-Task prompt will give you a `target_words` figure
calibrated to the source. Treat it as a guide, not a hard cap — go
30% over if the worked example needs the room, but don't pad to hit
a number that the source doesn't justify.

Mandatory structure for every section:

1. **One-paragraph orientation.** What is this idea? Why does the
   chapter introduce it here? What does the reader already need to
   know to follow it? (One or two anchors back to earlier sections.)
2. **The core development.** Define each term as you introduce it.
   Build any formula up step by step (don't drop it whole); say what
   each variable means and what it does to the result. State
   assumptions explicitly.
3. **At least one worked example.** A concrete, numerical (or
   concrete narrative) case that you walk through end-to-end with
   real values. "FCC copper, R = 0.128 nm, A = 63.5 g/mol →
   ρ ≈ 8.94 g/cm³" beats any amount of abstract prose. If the
   concept is qualitative (e.g., "ionic vs covalent bonding"), the
   example is a specific named instance with the properties spelled
   out (NaCl: cubic, brittle, melts at 801 °C, dissolves in water —
   contrast with SiC: covalent network, hard, melts at 2730 °C, inert).
4. **Why-it-matters callout (`pc-callout`).** One- or two-sentence
   pull-quote that names the consequence. "Atomic packing factor
   distinguishes structures that look similar geometrically but
   behave totally differently mechanically" — not "APF is important."
5. **Optionally: a contrast or edge case in `<details class="pc-skip">`.**
   Cases where the rule breaks (polymorphism, allotropy, glasses vs
   crystals). The reader can choose to dig in.

Examples are the most undervalued element. **Default to including a
worked numerical example or a named specific case for every concept
that has one.** The original textbook almost always has one — adapt
it; don't skip it just to save words.

## What "done" looks like

A pedagogical fragment that:
- Has the 5 structural blocks above (orientation → development →
  worked example → callout → optional skip).
- Defines every technical term on first use.
- Walks through any formula with at least one numeric instantiation.
- Wraps content in `<div class="pc-prose pc-stagger">`; uses
  animation classes on every visible child (`.pc-fade-in` /
  `.pc-rise` / `.pc-draw`).
- Uses one interactive figure when the concept has manipulable
  structure (parameter, state, position); skip the figure for purely
  textual ideas.
- Throws no console errors.

Don't ask the parent for clarification. Don't write anything outside the
file. When done, just exit.
