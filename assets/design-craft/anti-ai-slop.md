# Anti-AI-slop

Concrete tells that separate "designed by someone who has shipped product" from
"default model output". Several are enforced by the artifact linter — failing an
enforced rule is a regression, not a style preference. The rest are guidance and
are marked as such.

## The cardinal sins (P0 — blocked)

1. **Default Tailwind indigo/violet as accent.** `#6366f1`, `#4f46e5`, `#4338ca`,
   `#3730a3`, `#8b5cf6`, `#7c3aed`, `#a855f7`. The design system supplied
   `--accent`. Use it.
2. **Two-stop gradient hero.** purple→blue, blue→cyan, indigo→pink. Replace with
   a flat surface and real typographic hierarchy.
3. **Emoji as feature icons.** ✨ 🚀 🎯 ⚡ 🔥 💡 inside a heading, button, list
   item or anything named `icon`. Use 1.5–1.8px-stroke monoline SVG with
   `currentColor`.
4. **Filler copy.** `lorem ipsum`, `Feature One / Two / Three`, `placeholder
   text`, `sample content`, `Your headline here`. An empty section is a
   composition problem, not a word-count problem.
5. **Invented metrics.** "10× faster", "99.9% uptime", "trusted by 10,000 teams".
   Either cite a real source the user supplied, or label it visibly as example
   data. Demo market prices are never presented as live.
6. **Remote fonts and remote stylesheets.** Token stacks or local `@font-face`.
7. **External placeholder image CDNs.** `unsplash.com`, `placehold.co`,
   `picsum.photos`, `placekitten.com`. Use the local `.ph-img` placeholder.

## Soft tells (P1 — should fix)

- **The template skeleton**: Hero → 3 feature cards → Pricing → FAQ → CTA, with
  no variation. *(guidance)* Introduce at least one unconventional section: a
  full-bleed pull quote, pricing framed against the status quo, an inline
  mini-demo, a comparison table that takes a position.
- **Rounded card with a colored left border.** The canonical "AI dashboard tile".
  Drop the radius or drop the left border.
- **Three cards, always three.** Two, four, or an asymmetric 1+2 composition all
  read as more considered than the reflexive triptych.
- **Every corner rounded the same amount.** Pick a radius scale and vary it by
  element size; a 4px chip and a 600px panel should not share a radius.
- **Decorative blobs and wave dividers.** *(guidance)* Meaningless geometry
  filling space that composition should have solved.
- **Perfect symmetry with no tension.** *(guidance)* Alternate density — one
  tight section, one that breathes — so the rhythm reads as authored.

## Adding soul without breaking anything

Aim for roughly **80% proven patterns, 20% distinctive choice**. Spend the 20% on:

- **One bold move.** A typographic decision, a single color call, an unexpected
  proportion. One — not five.
- **Voice in the microcopy.** "Start tracking" beats "Get started". "Nothing here
  yet — add your first client" beats "No data".
- **One interaction worth remembering.** A button that depresses 1px. A number
  that counts up once. A row that reveals its actions on hover.
- **One detail only someone who used the product would add.** A keyboard hint, a
  status badge with domain-specific wording, a sensible default already filled in.

The test: screenshot it and show someone outside the project. If they can tell
which product it is, it has soul. If they cannot, it is a template.

## Automatically checked

`craft/anti-ai-slop` maps to lint rules `ai-default-indigo`,
`hero-two-stop-gradient`, `emoji-as-icon`, `filler-copy`, `invented-metric`,
`remote-font`, `placeholder-cdn`, `left-border-card`. Items marked *(guidance)*
are for the agent and reviewers; the linter does not check them.
