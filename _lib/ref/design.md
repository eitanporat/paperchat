# Design cheatsheet — autogo aesthetic for paperchat chapter sites

Inspired by Eric Jang's "AutoGo: a Tutorial". Read this instead of the
larger autogo.html / autogo-animations.jsx references — those are kept
for archival but you should not need them.

## Palette (already in pc.css — don't redeclare)

    --bg #f6f1e7   warm cream paper
    --paper #fbf6ea
    --ink #1f1a14
    --ink-soft #6a5d4a
    --accent oklch(58% 0.12 245)   blue (primary)
    --accent-alt oklch(55% 0.16 35) orange (contrast)

## Typography

Fonts loaded via @import in pc.css. Don't re-import.

    body / prose:  'Fraunces', Georgia, serif   (weight 400)
    headings:      same, weight 400 (literary, restrained — NOT bold)
    eyebrows:      'JetBrains Mono', mono, 11px, 0.22em tracking, uppercase

## Class vocabulary — use these, don't invent new ones

    .pc-page             one concept page (hash-routed if 2+)
    .pc-prose            prose container (Fraunces typography)
    .pc-eyebrow          mono uppercase label above sections
    .pc-figure           figure block
    .pc-figure--zoom     opt-in click-to-enlarge
    .pc-fig-interactive  host for JS/SVG figures
    .pc-callout          aside / definition / note
    .pc-callout--alt     orange-accent variant (rare)
    .pc-skip             collapsible low-importance (<details>)
    .pc-nav              site nav with hash-routed page links

## Animation primitives (already wired in pc.css + pc.js)

Just add the class — the IntersectionObserver triggers the animation when
the element scrolls into view.

    .pc-fade-in    subtle fade + 8px rise   (default for text/callouts)
    .pc-rise       fade + 16px rise         (headers, figures)
    .pc-stagger    parent — children with .pc-fade-in/.pc-rise stagger 40ms
    .pc-draw       on an SVG <path>         strokes itself in over 1.2s

Cross-fade between pages on hash change (140ms baseline) is automatic.

For per-figure timelines:

    pcSite.timeline([{at: 0, run: () => fadeIn(el1)}, {at: 400, run: ...}])
    pcSite.drawPath(pathElement, durationMs)

All animations honor prefers-reduced-motion — don't worry about it.

## Autogo idiom → paperchat equivalent

    autogo (React)                 paperchat (vanilla)
    ─────────────────────────────  ─────────────────────────────
    <Sprite start={1} end={4}>     <section class="pc-page">
    entrance fade                  class="pc-fade-in"
    staggered children             parent "pc-stagger"
    SVG path drawing in            <path class="pc-draw">
    useTime() timeline             pcSite.timeline([...])
    Easing.easeInOutCubic          cubic-bezier(0.2, 0.7, 0.2, 1)
    140ms transition baseline      already in pc.css

## DO

- Inline pc.css verbatim from `_lib/pc.css` into your <style>
- Inline pc-math.js and pc.js as <script type="module">
- Load KaTeX from CDN (head boilerplate is in `_lib/template.html`)
- Use eyebrows: `<div class="pc-eyebrow">part 2 · the model</div>`
- Mark less-essential material with `<details class="pc-skip">…</details>`
- For interactive figures, copy a snippet from `components.html` (chain
  diagram, timeline, comparison grid, slider, before/after, stepped
  reveal) and customize the content — don't rebuild from scratch

## DON'T

- No `.card` class anywhere. Use `.pc-callout` / `.pc-figure-interactive`.
- No bold headings. Keep weight 400.
- No HTML entities in CSS `content`. Use literal chars or `\\25BA` hex escapes.
- Don't redeclare any `.pc-*` selector — pc.css owns them.
- Don't embed rasterized page images (`pages/page-*.png`) as figures —
  those are for YOUR reference. Use `figures/img-*` or recreate as SVG.
