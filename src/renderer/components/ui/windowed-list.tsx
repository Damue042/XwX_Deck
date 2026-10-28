import * as React from 'react';

function MeasuredRow({ children, onHeight, ...props }: React.ComponentPropsWithoutRef<'div'> & { onHeight: (height: number) => void }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  const reportHeight = React.useRef(onHeight);
  reportHeight.current = onHeight;
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => reportHeight.current(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} {...props}>{children}</div>;
}

/** A bounded list with measured row heights, including expanded conflict details. */
export function WindowedList<T>({ items, itemKey, renderItem, label, scrollTop = 0, onScrollChange }: {
  items: readonly T[]; itemKey: (item: T) => string; renderItem: (item: T) => React.ReactNode;
  label: string; scrollTop?: number; onScrollChange?: (top: number) => void;
}): React.ReactElement {
  const viewport = React.useRef<HTMLDivElement>(null);
  const heights = React.useRef(new Map<string, number>());
  const [, resize] = React.useReducer((n: number) => n + 1, 0);
  const [view, setView] = React.useState({ top: scrollTop, height: 500 });
  const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
  const windowed = items.length > 80;
  const offsets = [0];
  for (const item of items) offsets.push(offsets[offsets.length - 1] + (heights.current.get(itemKey(item)) ?? 43));
  React.useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    element.scrollTop = scrollTop;
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [windowed]);
  const keys = items.map(itemKey);
  React.useLayoutEffect(() => {
    if (viewport.current && Math.abs(viewport.current.scrollTop - scrollTop) > 1) {
      viewport.current.scrollTop = scrollTop;
      setView(current => ({ ...current, top: viewport.current!.scrollTop }));
    }
  }, [scrollTop, keys.join('\0')]);
  let start = 0;
  while (start < items.length - 1 && offsets[start + 1] < view.top - 200) start++;
  let end = start;
  while (end < items.length && offsets[end] < view.top + view.height + 200) end++;
  const indices = windowed ? Array.from({ length: end - start }, (_, n) => start + n) : items.map((_, n) => n);
  const focusedIndex = focusedKey ? keys.indexOf(focusedKey) : -1;
  if (windowed && focusedIndex >= 0 && !indices.includes(focusedIndex)) indices.push(focusedIndex);
  return <div ref={viewport} className={windowed ? 'windowed-list' : undefined} role="list" aria-label={label}
    tabIndex={windowed ? 0 : undefined} onScroll={event => {
      const top = event.currentTarget.scrollTop;
      setView(current => ({ ...current, top })); onScrollChange?.(top);
    }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedKey(null); }}>
    <div style={windowed ? { position: 'relative', height: offsets[items.length] } : undefined}>
      {indices.map(index => <MeasuredRow key={keys[index]} role="listitem" aria-posinset={index + 1} aria-setsize={items.length}
        onFocusCapture={() => setFocusedKey(keys[index])}
        style={windowed ? { position: 'absolute', top: offsets[index], left: 0, right: 0 } : undefined}
        onHeight={height => { if (height > 0 && heights.current.get(keys[index]) !== height) { heights.current.set(keys[index], height); resize(); } }}>
        {renderItem(items[index])}
      </MeasuredRow>)}
    </div>
  </div>;
}
