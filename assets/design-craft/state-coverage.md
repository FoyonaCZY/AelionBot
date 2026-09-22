# State coverage

A screen is not one picture. Any surface that holds data or accepts input has
states, and the unhandled ones are what make a prototype feel fake.

## Every interactive element

Cover all six. A control styled only for its resting state is unfinished:

| State | Requirement |
|---|---|
| default | The resting appearance |
| hover | A visible change — background, border, or 1px transform. Pointer devices only |
| focus-visible | **Never remove the outline without replacing it.** 2px ring, 2px offset, 3:1 contrast |
| active | A pressed affordance — usually a 1px downward shift or a darker surface |
| disabled | Reduced contrast, `cursor: not-allowed`, and removed from the tab order |
| loading | For anything that triggers async work: a spinner or skeleton in place, and the control locked against double submission |

Anchors count. An unstyled `<a>` inheriting browser blue-and-underline inside a
designed page is the loudest possible signal that the page was not finished.

## Every data surface

A list, table, grid, chart or search result needs four renderings:

- **Empty** — not a blank box. Say what belongs here and give the action that
  creates the first item. Write real copy: "No invoices yet — create one to get
  started", never "No data".
- **Loading** — skeletons that match the real layout's shape and count. A
  centered spinner in a large region reads as a stall.
- **Error** — what failed, and what the user can do. Never a raw status code.
- **Populated** — and separately, **overflowing**: very long strings, 200 rows,
  a name that does not fit. Decide truncation, wrapping and pagination now.

## Forms

- Validate on blur, not on every keystroke; re-validate on change once a field
  has already errored.
- The error message sits adjacent to the field, is linked with
  `aria-describedby`, and says how to fix it.
- Never rely on placeholder text as a label. The placeholder disappears exactly
  when the user needs it.
- Submit is disabled *or* it explains what is missing — not silently inert.

## Prototype honesty

- A visible control either performs a working prototype action, or is visibly
  marked as a placeholder. A button that does nothing when clicked, with no
  indication, is the defect the user will notice first.
- Sample data is labelled as sample. Never present fabricated numbers as live.

## Automatically checked

`craft/state-coverage` maps to lint rules `unstyled-anchor`,
`focus-outline-removed`, `no-hover-state`, `dead-control`, `missing-empty-state`.
Loading and error rendering are guidance.
