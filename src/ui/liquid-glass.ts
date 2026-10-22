import { useId, useLayoutEffect, type RefObject } from 'react';

const SVG = 'http://www.w3.org/2000/svg';
const DEFS_ID = 'liquid-glass-defs';

/**
 * Displacement map for a rounded pane of the given size, as RGBA bytes. Red and green carry the horizontal and
 * vertical offset (128 = none). The middle stays neutral; within `band` of the edge the map pulls samples inward, so
 * what lies behind the rim bends and magnifies like the edge of a thick lens.
 */
export function liquidGlassMap(width: number, height: number, radius: number, band: number) {
  const data = new Uint8ClampedArray(width * height * 4),
    halfW = width / 2,
    halfH = height / 2,
    r = Math.max(0, Math.min(radius, halfW, halfH));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const px = x + 0.5 - halfW,
        py = y + 0.5 - halfH,
        qx = Math.abs(px) - (halfW - r),
        qy = Math.abs(py) - (halfH - r);
      let depth: number, nx: number, ny: number;
      if (qx > 0 && qy > 0) {
        const length = Math.hypot(qx, qy);
        depth = r - length;
        nx = (Math.sign(px) * qx) / length;
        ny = (Math.sign(py) * qy) / length;
      } else if (qx > qy) {
        depth = r - qx;
        nx = Math.sign(px);
        ny = 0;
      } else {
        depth = r - qy;
        nx = 0;
        ny = Math.sign(py);
      }
      const t = Math.min(1, Math.max(0, 1 - depth / band)) ** 2,
        index = (y * width + x) * 4;
      data[index] = 128 - nx * t * 127;
      data[index + 1] = 128 - ny * t * 127;
      data[index + 2] = 128;
      data[index + 3] = 255;
    }
  return data;
}

const attributes = (element: Element, values: Record<string, string | number>) => {
  for (const [name, value] of Object.entries(values)) element.setAttribute(name, String(value));
  return element;
};

/**
 * Gives an element a refracting backdrop: an SVG filter of its own, with a displacement map redrawn whenever its size
 * or corner radius changes. The filter is exposed as --liquid-filter; CSS decides whether to use it (glass-shell.css).
 */
export function useLiquidGlass(ref: RefObject<HTMLElement | null>) {
  const id = 'liquid-glass-' + useId().replace(/[^\w-]/g, '');
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const defs =
      document.getElementById(DEFS_ID) ??
      document.body.appendChild(
        attributes(document.createElementNS(SVG, 'svg'), {
          id: DEFS_ID,
          width: 0,
          height: 0,
          'aria-hidden': 'true',
          style: 'position:absolute;pointer-events:none',
        }),
      );
    const filter = attributes(document.createElementNS(SVG, 'filter'), {
        id,
        'color-interpolation-filters': 'sRGB',
      }),
      image = attributes(document.createElementNS(SVG, 'feImage'), {
        result: 'map',
        x: 0,
        y: 0,
        preserveAspectRatio: 'none',
      }),
      displace = attributes(document.createElementNS(SVG, 'feDisplacementMap'), {
        in: 'soft',
        in2: 'map',
        xChannelSelector: 'R',
        yChannelSelector: 'G',
        result: 'bent',
      });
    filter.append(
      image,
      attributes(document.createElementNS(SVG, 'feGaussianBlur'), {
        in: 'SourceGraphic',
        stdDeviation: 4,
        result: 'soft',
      }),
      displace,
      attributes(document.createElementNS(SVG, 'feColorMatrix'), { in: 'bent', type: 'saturate', values: 1.8 }),
    );
    defs.appendChild(filter);
    const canvas = document.createElement('canvas');
    let frame = 0,
      drawn = '';
    const draw = () => {
      frame = 0;
      const width = Math.round(element.offsetWidth),
        height = Math.round(element.offsetHeight),
        radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0,
        key = `${width}x${height}x${radius}`;
      if (!width || !height || key === drawn) return;
      drawn = key;
      const band = Math.min(28, Math.min(width, height) * 0.38);
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')?.putImageData(new ImageData(liquidGlassMap(width, height, radius, band), width), 0, 0);
      attributes(image, { href: canvas.toDataURL(), width, height });
      displace.setAttribute('scale', String(Math.round(band * 1.8)));
      element.style.setProperty('--liquid-filter', `url(#${id})`);
    };
    const observer = new ResizeObserver(() => {
      frame ||= requestAnimationFrame(draw);
    });
    observer.observe(element);
    draw();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      filter.remove();
      element.style.removeProperty('--liquid-filter');
      if (!defs.childElementCount) defs.remove();
    };
  }, [id, ref]);
}
