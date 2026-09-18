# Spacing audit

Use this only as an optional visual check. It is not a general skill and does not expand permissions.

- Prefer the pinned design system's spacing tokens (`--space-*`, `--spacing-*`, `--gap-*`, `--pad-*`, `--radius-*`) over raw `px` padding, margin and gap.
- Keep one vertical rhythm: section padding should step (for example S / M / L), not unique values on every block.
- Related actions share the same gap. Isolated elements can use a larger step, not a one-off number.
- After a user comment on a control, patch spacing around that `data-design-id` first; do not restyle the whole page to "fix rhythm".
