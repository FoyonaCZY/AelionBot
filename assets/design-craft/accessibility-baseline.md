# Accessibility baseline

The floor, not the ceiling. These cost nothing at authoring time and are
expensive to retrofit.

## Structure

- One `<h1>` per page. Heading levels descend without skipping — an `<h3>`
  directly under an `<h1>` is a structural bug, not a sizing choice.
- Use the real elements: `<header>`, `<nav>`, `<main>`, `<section>`, `<footer>`,
  `<button>`, `<a>`. A `<div onclick>` is not a button — it has no focus, no
  keyboard activation and no role.
- `<a>` navigates, `<button>` acts. An anchor with `href="#"` that runs script is
  a button wearing the wrong element.
- Landmark `<main>` exists and wraps the primary content.

## Keyboard

- Every interactive element is reachable by Tab, in visual order. Do not set
  positive `tabindex`.
- `:focus-visible` is styled on everything focusable: 2px ring, 2px offset,
  ≥3:1 against the adjacent surface. If you write `outline: none`, the very next
  declaration replaces it.
- Escape closes any overlay. Focus moves into a dialog when it opens and returns
  to the trigger when it closes.
- A skip link to `#main` is the first focusable element on a page with a nav.

## Perceivable

- Text contrast ≥4.5:1; large text and UI borders ≥3:1.
- Never encode meaning in color alone — pair it with an icon, a label or a shape.
- Every meaningful `<img>` has a descriptive `alt`. Decorative images take
  `alt=""`. An icon-only button takes `aria-label`.
- Tap targets ≥44×44 CSS pixels on touch layouts, ≥24×24 with spacing on desktop.
- Respect `prefers-reduced-motion`: disable transforms and parallax, keep opacity.
- Do not disable zoom. No `maximum-scale=1` or `user-scalable=no`.

## Content

- `<html lang>` is set and matches the document's actual language.
- Form inputs have a real `<label for>` — or an `aria-label` when the design
  genuinely has no visible label.
- Link text makes sense out of context. "Read the pricing guide", not
  "click here".
- Tables that carry data use `<th scope>` and a `<caption>`.

## Automatically checked

`craft/accessibility-baseline` maps to lint rules `missing-lang`,
`heading-order`, `div-as-button`, `focus-outline-removed`, `image-without-alt`,
`icon-button-without-label`, `zoom-disabled`, `input-without-label`.
Contrast ratios, focus order and dialog focus management are guidance —
claiming them verified requires actual evidence.
