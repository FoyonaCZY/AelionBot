# Motion discipline

Motion is feedback, not decoration. Most pages need very little of it, and the
little they need is short.

## Budget

- Under 150ms: state feedback — hover, press, focus ring, color change.
- 150–250ms: element transitions — dropdown open, tooltip, accordion, tab swap.
- 250–400ms: layout or page-level transitions. Rarely justified.
- Over 400ms: only for a deliberate first-load reveal, once, never on repeat.

If you cannot name what a transition tells the user, delete it.

## Easing

- Entering: decelerate — `cubic-bezier(0, 0, 0.2, 1)`. Fast in, gentle landing.
- Exiting: accelerate — `cubic-bezier(0.4, 0, 1, 1)`. Get out of the way.
- Moving between two on-screen positions: `cubic-bezier(0.4, 0, 0.2, 1)`.
- Never `linear` for anything an element does physically. Reserve it for
  progress and spinners.

## What to animate

- Animate `transform` and `opacity`. They composite on the GPU.
- Animating `width`, `height`, `top`, `left` or `margin` forces layout every
  frame. If you need a size change, prefer `scale`, or accept the cost knowingly
  on a small element.
- Never animate `box-shadow` directly — cross-fade two stacked shadow layers.
- Stagger a list by 20–40ms per item, capped at about 6 items. Beyond that the
  last item arrives late enough to feel broken.

## Restraint

- One meaningful animated moment per screen. Two competing animations cancel
  each other's meaning.
- Nothing that moves continuously while the user is trying to read.
- No scroll-jacking. No `scrollIntoView` inside an embedded preview — it breaks
  the frame.
- Motion never carries information on its own. If an animation conveys state,
  that state must also be visible when the animation is disabled.

## Reduced motion

Always ship this, and make it the last rule in the stylesheet:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Opacity fades may remain; transforms, parallax and auto-playing loops must not.

## Automatically checked

`craft/motion-discipline` maps to lint rules `missing-reduced-motion`,
`layout-animated-property`, `overlong-transition`. Easing choices and
restraint are guidance.
