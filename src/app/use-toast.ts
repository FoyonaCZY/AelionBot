import { useEffect, useState } from 'react';

/** A transient status line that clears itself six seconds after the latest message. */
export function useToast() {
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  return [toast, setToast] as const;
}
