import { useEffect, useState } from 'react';

/** The design session opened in the drawer; task cards request it with an `aelion-design-task` event. */
export function useDesignTask() {
  const [designTaskId, setDesignTaskId] = useState<string>();
  useEffect(() => {
    const show = (event: Event) => setDesignTaskId((event as CustomEvent).detail?.id);
    window.addEventListener('aelion-design-task', show);
    return () => window.removeEventListener('aelion-design-task', show);
  }, []);
  return [designTaskId, setDesignTaskId] as const;
}
