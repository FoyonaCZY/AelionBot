import { useEffect, useState } from 'react';

/** How long .ui-collapse (src/styles/controls.css) takes to close. */
const CLOSE_MS = 220;

/**
 * Keeps collapsible content mounted while it animates shut. Render it while `mounted`, inside a `.ui-collapse` with
 * `data-closing` set while `closing`; it opens by itself from @starting-style.
 */
export function useCollapse(open: boolean) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [open]);
  return { mounted: open || mounted, closing: !open && mounted };
}
