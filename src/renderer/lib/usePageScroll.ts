import * as React from 'react';

/** Keep the page position independently for every selected client or profile. */
export function usePageScroll(ref: React.RefObject<HTMLElement | null>, key: string, active: boolean): void {
  const positions = React.useRef(new Map<string, number>());
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    element.scrollTop = positions.current.get(key) ?? 0;
    const remember = () => positions.current.set(key, element.scrollTop);
    element.addEventListener('scroll', remember);
    return () => element.removeEventListener('scroll', remember);
  }, [ref, key, active]);
}
