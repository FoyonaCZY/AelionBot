# Imagery

How to use pictures in a design, and what to do when you cannot get one.

## Choose the aspect before the prompt

Aspect ratio is a layout decision, not a generation detail. Decide where the
image sits, then request that shape:

| Slot | Aspect |
|---|---|
| Hero banner, wide feature strip | `16:9` |
| Phone screen, poster, story card | `9:16` |
| Avatar, logo mark, icon tile | `1:1` |
| Card thumbnail, editorial figure | `4:3` |
| Landscape photo block | `3:2` |

A square image dropped into a 16:9 slot will be cropped or letterboxed by the
browser, and both look like a mistake. Always reserve the box in CSS with
`aspect-ratio` so the layout does not reflow when the image loads.

## Prefer composition over generation

Before generating anything, ask whether the design actually needs a picture:

- A strong type lockup, a rule, and generous space beat a decorative stock image.
- Diagrams, charts, patterns, gradients-as-texture and icon sets are better as
  inline SVG or CSS. They stay crisp, restyle with tokens, and cost nothing.
- Generate when the design genuinely needs photographic or illustrative content
  — a product shot, an editorial illustration, a textured backdrop.

## When generation fails

Image generation can fail for reasons you cannot fix from inside the task: no
model configured, an expired key, exhausted credit, a content refusal. The
failure carries a `nextStep`. **Only `retry-later` may be retried, once.** Every
other value means stop calling the tool — a second call cannot change the
outcome and may bill the user again.

A failed image is never a reason to ship an empty region. Fall back to a
designed placeholder that holds the composition:

```css
.ph-img{
  position:relative; display:grid; place-items:center;
  aspect-ratio:var(--ph-ratio, 16 / 9);
  background:color-mix(in oklch, var(--ink, #14151a) 5%, transparent);
  border:1px solid color-mix(in oklch, var(--ink, #14151a) 12%, transparent);
  border-radius:var(--radius-md, 12px);
  color:color-mix(in oklch, var(--ink, #14151a) 55%, transparent);
  font-size:.8125rem; letter-spacing:.02em; text-align:center; padding:1rem;
}
```

```html
<figure class="ph-img" style="--ph-ratio: 16 / 9" data-design-id="hero-figure">
  产品主视觉（占位）
</figure>
```

Rules for the placeholder:

- It occupies the **real** aspect ratio the final image would, so the layout is
  already correct when a picture arrives.
- Its caption names what belongs there, in the page's language. Never
  "placeholder image" or a gray box with nothing in it.
- It is styled from tokens, so it reads as part of the design rather than as a
  broken asset.
- Never point it at an external placeholder CDN. Those are fragile, obvious, and
  make the page depend on the network.
- Say plainly in the reply that it is a placeholder and why. Do not describe a
  picture that was never generated.

## Using the images you do have

- Every meaningful `<img>` carries a descriptive `alt`; decorative ones take
  `alt=""`.
- Set `loading="lazy"` and `decoding="async"` on anything below the fold.
- Reference assets by relative path under `assets/`. No remote image hosts.
- Keep the generated file where the tool wrote it and use the returned path —
  do not rename it to a guessed extension.

## Automatically checked

`craft/imagery` maps to lint rules `placeholder-cdn`, `image-without-alt`.
Aspect discipline and placeholder quality are guidance.
