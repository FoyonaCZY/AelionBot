# Typography

Universal type craft. True regardless of which design system is selected — the
system supplies the families and the scale; these rules govern how you use them.

## Scale

- Pick the scale before writing markup, and state it in one line to the user.
  A page has **one** scale. Typical web ramp: 12 / 14 / 16 / 20 / 24 / 32 / 48 / 64.
- Use at most 5 sizes on a page. More than 5 reads as unplanned.
- Body copy is 16px minimum on web, 24px minimum on a 1920×1080 slide,
  12pt minimum in print. Never shrink body text to make content fit — cut content.
- Step sizes by ratio, not by arbitrary pixels. 1.25 (minor third) for dense UI,
  1.333–1.5 for editorial and marketing.

## Hierarchy

- Every screen has exactly one primary entry point — the largest, heaviest,
  or most isolated element. If two elements compete, neither wins.
- Build hierarchy from **size, weight, color and space** in that order of strength.
  Reach for space before you reach for another color.
- Adjacent levels must differ by at least one full step. `h1` at 32 and `h2` at 28
  is not a hierarchy, it is noise.
- Do not center long-form text. Centering is for short, deliberate statements —
  a hero line, a section kicker, a closing call.

## Setting

- Measure (line length) is 45–75 characters for body copy. Use `max-width: 65ch`,
  not a pixel width that happens to look right at your viewport.
- Line height scales inversely with size: 1.5–1.7 for body, 1.1–1.25 for display.
  A 48px heading at `line-height: 1.5` looks like a mistake because it is one.
- Tracking scales inversely too. Display text above ~32px wants slightly negative
  tracking (−0.01em to −0.03em). **ALL CAPS always needs ≥0.06em** — no exceptions,
  no matter what the brand is.
- Use `text-wrap: balance` on headings and `text-wrap: pretty` on body copy.
- Numerals in tables, prices and dashboards use `font-variant-numeric: tabular-nums`.

## Families

- Take families from the design system's tokens. If the system binds a serif to
  display, `h1`–`h3` use `var(--font-display)`; do not silently substitute a sans.
- Choose needed open-source fonts autonomously within the requested design,
  respecting explicit font and brand constraints. Reuse available project fonts
  first. Do not require the user to download files or operate the Fonts panel.
- Use `design_fonts` to search, acquire or import actual font files. Use
  `design_font_apply` for body/display/mono roles, or link the returned local
  `cssPath`. Check the actual text for missing characters and required weights.
- Font names in design tokens are references, not proof that a font is available.
  Project font tokens may override them for the requested design. Report missing
  fonts and chosen substitutes instead of silently accepting fallback.
- Downloaded font assets are allowed. Keep remote Google Fonts, Typekit and
  remote `@import` out of the final artifact; use project-local font resources.
- Use `design_export_project` to deliver HTML with its fonts and license files,
  and `design_export_pdf` for PDF. These tools do not embed fonts into PPTX.
- Two families maximum: one for display, one for text. A third is a mono for code
  or data, and only when there is code or data.
- Inherit the chosen family into form controls. Browsers default `input`,
  `button`, `select` and `textarea` to the system UI font; that single omission is
  the most common reason a page "looks unfinished".

## Automatically checked

`craft/typography` maps to lint rules `display-font-substituted`,
`caps-without-tracking`, `remote-font`, `control-font-not-inherited`,
`too-many-type-sizes`. Everything else here is guidance a reviewer applies.
