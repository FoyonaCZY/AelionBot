# Layout and rhythm

Composition rules that hold regardless of brand. The design system gives you
tokens; this gives you the arrangement.

## Spacing

- One spacing scale, geometric, used everywhere: 4 / 8 / 12 / 16 / 24 / 32 / 48 /
  64 / 96. No arbitrary `margin: 13px`.
- Space belongs to the **group**, not the element. Use `gap` on a flex/grid
  parent rather than margins on children; it survives reordering and removal.
- Proximity encodes relationship. The gap inside a group must be visibly smaller
  than the gap between groups — usually a 1:2 ratio or more. Most "cluttered"
  layouts are actually uniform-spacing layouts.
- Vertical section padding on a marketing page is large: 64–128px. Cramped
  sections are the fastest way to look unfinished.

## Structure

- Choose the grid before writing markup. A 12-column grid, a 3-column asymmetric
  split, a single centered measure — say which, then hold it.
- Content width: 1100–1280px for marketing, 65ch for reading, full-bleed only for
  deliberate moments. Do not let text run the full width of a 1920px monitor.
- Alignment is binary — either two elements align or they do not. There is no
  "close enough". Establish 2–3 alignment edges and snap everything to them.
- Use CSS Grid for page structure and Flexbox inside components. Reach for
  `grid-template-areas` when the layout has a name.

## Rhythm

- Vary density deliberately. A page where every section has the same padding,
  the same card count and the same text length reads as generated. Alternate:
  dense → airy → dense.
- Vary section *shape*, not just content. A full-bleed band, a two-column split,
  a centered statement and a grid in sequence create rhythm; four grids do not.
- One focal point per viewport. As the user scrolls, exactly one thing should be
  clearly the most important at any moment.

## Responsiveness

- Design the narrow width as a real layout, not a squeezed desktop. Reflow
  columns to stack, reduce the type scale one step, increase tap targets.
- Test at 360px, 768px and 1440px. No horizontal overflow at any of them — a
  single unwrapped table or a fixed-width image is usually the culprit.
- Use `clamp()` for fluid type and spacing instead of three breakpoints of
  hand-tuned pixels.
- Container queries where a component must adapt to its slot rather than the
  viewport.

## Automatically checked

`craft/layout-rhythm` maps to lint rules `off-scale-spacing`,
`uniform-radius`, `missing-viewport-meta`, `fixed-width-overflow-risk`.
Rhythm and alignment are guidance a reviewer applies.
