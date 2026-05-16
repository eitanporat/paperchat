# Subagent brief — read this once, then act

You write ONE HTML fragment to `sections/<your-id>.html`. Everything
you need is in this file. The planner already vetted the figures and
told you which ones to use — trust the brief, don't re-read figures.

## Output shape

A fragment (NO `<html>`/`<head>`/outer `<section>`). Top wrapper:
`<div class="pc-prose pc-stagger">…</div>`. Parent injects this into a
pre-built `<section class="pc-page">` placeholder.

```html
<div class="pc-prose pc-stagger">
  <div class="pc-eyebrow pc-fade-in">Section 2.3</div>
  <div class="pc-source pc-fade-in" data-page="40">pp. 40–42</div>
  <p class="pc-fade-in">Opening: what is this idea, why introduced here, what's prerequisite.</p>

  <p class="pc-fade-in">Develop the concept. Define every term on first use.
  Build any formula step by step. Use <strong>bold</strong> + <em>italics</em>
  + math: $E = mc^2$ inline, $$F = ma$$ display.</p>

  <!-- interactive figure goes here (see Components below) -->

  <div class="pc-callout pc-fade-in">
    <div class="pc-callout-title">Why it matters</div>
    One- or two-sentence pull-quote naming the consequence.
  </div>

  <pc-anki>
    <script type="application/json">
      [{"q": "…", "a": "…"}, …]
    </script>
  </pc-anki>

  <details class="pc-skip"><summary>Skipped: …</summary>Optional depth.</details>
</div>
```

## Image paths

Fragments are injected into `index.html`'s DOM, so relative URLs
resolve against `index.html` (NOT `sections/`). Use `figures/…` —
never `../figures/` or `/figures/`.

## Audience + length

Write for a first-time reader. Define terms on first use; build
formulas step by step; include a worked example or named case
when it teaches; skip when it would feel forced. Length: as short
as possible while still teaching, always shorter than the source.
Use judgment based on the material — short asides get a stub
summary, dense derivations get the room they need.

## Source-page citation

`<div class="pc-source" data-page="40">pp. 40–42</div>` under the
eyebrow. `data-page` is the first source page (1-indexed PDF
number). Clicking jumps the underlying PDF viewer to that page.
Format the visible text: `p. 41` / `pp. 40–42` (en-dash) /
`pp. 38, 41–42` for ranges.

## Class vocabulary

    .pc-prose          prose container (start with this)
    .pc-eyebrow        mono uppercase label
    .pc-source         clickable source citation
    .pc-figure         figure wrapper (use .pc-figure--zoom for click-to-enlarge)
    .pc-fig-interactive  host for an interactive figure
    .pc-callout        pulled-out tip (.pc-callout--alt for orange)
    .pc-skip           collapsible low-priority block

Animation classes (apply liberally):

    .pc-fade-in        subtle rise (default for paragraphs)
    .pc-rise           stronger rise (headings, figures)
    .pc-draw           on an SVG <path> — strokes itself in

Parent has `.pc-stagger` so children animate in sequence.

# Components — interactive figures via web components

Write ONE tag + JSON. The component handles geometry, theming,
animation, click wiring. NO inline SVG/IIFE for these patterns.

    pc-chain      A → B → C → D process, click for detail
    pc-stepped    prev/next walkthrough
    pc-timeline   horizontal time axis, click for context
    pc-grid       N-way comparison cards
    pc-toggle     A/B state switch with per-state body
    pc-slider     parametric exploration (`formula` is JS over `x`)
    pc-plot       line/bar/scatter chart from {series:[{points}]}
    pc-annotated  image + numbered hotspots that reveal labels
    pc-equation   KaTeX equation + clickable symbol legend
    pc-tree       hierarchical content as nested collapsible cards
    pc-term       inline term with hover-tooltip definition
    pc-anki       review-card deck (at the END of every section)
    pc-3d         interactive 3D scene (orbit, zoom, labels)

Examples in `_lib/ref/components.html`.

## JSON payload — prefer the script form

`data='[…]'` attribute breaks when JSON contains apostrophes
(`Hund's`) or when you mis-type `"` as `'`. Always safe alternative:

    <pc-stepped>
      <script type="application/json">
        [{"title": "Hund's rule", "body": "…"}]
      </script>
    </pc-stepped>

Use `data='[…]'` only for short, apostrophe-free payloads.

## pc-term: define every technical term

Wrap every technical term on first appearance:

    <pc-term def="Three edge lengths $a$,$b$,$c$ and three angles.">
      lattice parameters
    </pc-term>

Reader hovers/focuses for the definition. KaTeX in `def` works.
1–2 sentences. Don't re-wrap the same term every appearance.

## pc-anki: review at end

Self-test deck after the callout. Use the script form. Mix
definitions, comparisons, computations, reasoning, traps. Length
is your call — match the section's density.

## 3D — use pc-3d when geometry matters

If the concept's MEANING changes with viewing angle (crystal
unit cells, atomic orbitals, molecular structure, lattice planes,
3D vectors, polyhedra, brain regions, planet orbits…), use
`pc-3d`. Don't flatten to a 2D approximation — the reader rotates
and inspects from any angle.

    <pc-3d>
      <script type="application/json">
        {
          "objects": [
            {"type": "sphere", "pos": [0,0,0], "r": 0.4, "color": "#c25b2a", "label": "Fe"},
            {"type": "sphere", "pos": [1,0,0], "r": 0.4, "color": "#888"},
            {"type": "cylinder", "from": [0,0,0], "to": [1,0,0], "r": 0.05},
            {"type": "box", "pos": [0.5,0.5,0.5], "size": [1,1,1], "wireframe": true},
            {"type": "label", "pos": [0.5,1.1,0.5], "text": "a"}
          ],
          "camera": [2,2,3],
          "axes": true,
          "caption": "BCC unit cell"
        }
      </script>
    </pc-3d>

Object types: `sphere {pos, r, color, label?}`, `box
{pos, size, wireframe?, color?}`, `cylinder {from, to, r, color?}`
(bonds/sticks), `line {from, to, color?, dashed?}`, `arrow
{from, to, color?}`, `label {pos, text}`. Scene fields:
`camera`, `axes` (show xyz axes), `grid`, `autoRotate`,
`caption`. The component loads Three.js on demand.

For molecules specifically, **3Dmol.js** does PDB/mol/SDF with
one line; for ready-made GLB files use Google's
`<model-viewer>`. Both load via CDN script tag if pc-3d's
declarative scene isn't expressive enough.

## Custom interactive figures — when no component fits

If the concept has manipulable structure that no pc-* captures,
build a one-off web component inside the section file:

    <atom-shells data='{"Z":6}'></atom-shells>
    <script>
      class AtomShells extends HTMLElement {
        connectedCallback() {
          const d = JSON.parse(this.getAttribute('data') || '{}');
          this.innerHTML = `<figure class="pc-fig-interactive pc-rise">…</figure>`;
          // wire click/drag/slider here
        }
      }
      customElements.define('atom-shells', AtomShells);
    </script>

Verify physics/math at boundary points before shipping (F=0 at
equilibrium, V negative at minimum, probabilities normalized,
angles wrap mod 2π). Wrong-sign physics teaches the wrong thing
— worse than no figure.

## Default to interactivity

Hierarchy for any explanation:
1. **Direct interaction** — slider, click, drag (pc-slider, pc-toggle, pc-stepped, pc-annotated, pc-3d, custom).
2. **Layered reveal** — hover (pc-term), click (pc-chain, pc-equation).
3. **Static figure** — table, diagram.
4. **Prose** — only when 1–3 wouldn't fit.

Examples: "7 crystal systems" → pc-grid, not 7 paragraphs.
"Aufbau order" → pc-stepped. "Ionic vs covalent" → pc-toggle.
"Hierarchy of materials" → pc-tree.

# SVG pitfalls (re-read before writing SVG inline)

- **CSS vars don't work in SVG attrs.** `fill="var(--accent)"` is
  invalid — falls back to black. Use `style="fill: var(--accent)"`,
  or `fill="currentColor"`. (A compat shim in pc.css catches the
  common cases as a safety net.)
- Set `viewBox="0 0 W H"` and place every element inside it.
- `<text>` `y` is the BASELINE, not the top. For visually-centered
  text in a row from y0 height H, use `y = y0 + H * 0.7` or
  `dominant-baseline="middle"`.
- `<path d="…">` defaults to fill=black. For lines/strokes add
  `fill="none" stroke="…" stroke-width="…"`.
- Don't put `<style>` inside `<svg>` without scoping — leaks to
  other SVGs.

# JS pitfalls (re-read before writing `<script>`)

- Object literal property assignment is `:` not `=`. `{a:1, b=2}`
  is a SyntaxError that kills the whole script tag.
- `tr.rowIndex` is whole-table index, NOT tbody-only. Use
  `for (let i = 0; i < tbody.rows.length; i++)`.
- Multiple IIFEs in one `<script>` share fate. Split into separate
  `<script>` tags so one throw doesn't kill the others.
- Put each `<script>` AFTER the markup it manipulates.
- Call your render function ONCE after wiring listeners:
  `slider.oninput = render; render();`
- `<canvas>` defaults to 300×150. Set both `width`/`height` attrs
  AND matching `style="width:…;height:…"` to avoid blurry output.

# Math (KaTeX)

- Inline `$E = mc^2$`, display `$$\bar{A} = \sum_i f_i A_i$$`.
- Math is auto-rendered after sections inject — your job is
  valid LaTeX inside `$…$`.
- Use math grammar not HTML: `$x^2$` not `<sup>2</sup>`, `$O_2$`
  not `O<sub>2</sub>`.
- HTML entities like `&ell;` don't render as math in SVG `<text>`.
  Use Unicode codepoints (`ℓ`, `ψ`, `λ`) — they're in the font.

# Done = a fragment that

- Has the orient → develop → (optional example) → callout →
  pc-anki → (optional skip) flow.
- Defines every term on first use.
- Walks any formula step by step.
- Uses an interactive figure when the concept has manipulable
  structure; skips it for purely textual ideas.
- Throws no console errors.
- Is shorter than the source but long enough to teach.
