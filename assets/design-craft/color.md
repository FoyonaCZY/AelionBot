# Color

The selected design system decides *which* colors. This decides *how many*,
*where*, and *how much*.

## Token discipline

- Every color comes from a token. Define the palette once in `:root`, then use
  `var(--…)` everywhere else.
- More than ~12 raw hex values outside `:root` means the tokens were not honoured.
  Derive variants with `color-mix(in oklch, var(--accent) 12%, transparent)`
  instead of hand-picking a new hex.
- Do not invent a token the system does not have. If you need a subtle surface,
  mix an existing one; if you need a semantic state color, name it
  (`--danger`, `--success`) and define it once.

## Accent budget

- **At most two visible accent uses per screen.** The primary action, and one
  supporting emphasis. A third use makes all three stop meaning anything.
- The accent marks what the user should do, not what the designer liked. Nav
  items, decorative rules, icon fills and card borders are not accent territory.
- A page dominated by its accent has no hierarchy. Most of a good interface is
  neutral; the accent is the exception that reads as important.

## Neutrals carry the design

- Build a 5–7 step neutral ramp and use it for surfaces, borders and text.
  The difference between amateur and professional output is almost always the
  neutrals, not the accent.
- Borders are the lowest-contrast thing on the page — usually 8–14% of the text
  color, not a solid gray.
- Prefer one surface elevation change (background → card) over stacked shadows.
  If you use a shadow, it is large, soft, low-opacity and has a slight downward
  offset. Never a hard symmetric glow.

## Contrast

- Body text against its background: 4.5:1 minimum. Large text (≥24px, or ≥19px
  bold): 3:1. UI borders and control edges: 3:1.
- Never use color alone to convey state. An error is red **and** carries an icon
  or text. A selected tab is accented **and** structurally marked.
- Check dark mode separately if the design system ships one. A palette that
  passes in light frequently fails inverted, especially muted text.

## Avoid

- Default Tailwind indigo/violet as the accent (`#6366f1`, `#4f46e5`, `#4338ca`,
  `#8b5cf6`, `#7c3aed`, `#a855f7`). This is the single clearest tell of unedited
  model output. The design system already gave you an accent — use it.
- Two-stop "trust" gradients on a hero: purple→blue, blue→cyan, indigo→pink.
  A flat surface with intentional type beats every one of them.
- Unmotivated warm beige / cream / peach canvases. Fine when the brand calls for
  it; a tell when it appears by default.
- Rainbow category colors. If you need more than 4 categorical colors, you need
  a different encoding.

## Automatically checked

`craft/color` maps to lint rules `ai-default-indigo`, `hero-two-stop-gradient`,
`raw-hex-outside-root`, `accent-overused`. Contrast and dark mode are guidance.
