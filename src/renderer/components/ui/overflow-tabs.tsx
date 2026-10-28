import * as React from 'react';
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox';
import { ChevronDown, Plus } from 'lucide-react';
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxPopup } from './combobox';
import { TabsList, TabsTab } from './tabs';
import { t } from '@/lib/i18n';
import { Button } from './button';
import { Group } from './group';

export interface OverflowTab { id: string; label: string; }

/** Keep the selected tab visible; the searchable menu contains the entire list. */
export function OverflowTabs({ items, value, label, onSelect, disabled, id, tabId, tabData, action }: {
  items: readonly OverflowTab[]; value: string; label: string; onSelect: (id: string) => void;
  disabled?: boolean; id?: string; tabId?: (id: string) => string; tabData?: string;
  action?: { label: string; onClick: () => void; id?: string };
}): React.ReactElement {
  const container = React.useRef<HTMLDivElement>(null);
  const measurements = React.useRef<HTMLDivElement>(null);
  const actionMeasurement = React.useRef<HTMLSpanElement>(null);
  const [capacity, setCapacity] = React.useState(items.length);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const search = React.useRef<HTMLInputElement>(null);
  const signature = JSON.stringify(items);
  React.useLayoutEffect(() => {
    let frame = 0;
    let disposed = false;
    const measure = () => {
      if (!container.current || !measurements.current) return;
      if (!container.current.clientWidth) { setCapacity(items.length); return; }
      const widths = [...measurements.current.children].map(child => child.getBoundingClientRect().width);
      const available = container.current.clientWidth;
      const actionWidth = actionMeasurement.current ? actionMeasurement.current.getBoundingClientRect().width + 2 : 0;
      if (widths.reduce((sum, width) => sum + width + 2, 8) + actionWidth <= available) { setCapacity(items.length); return; }
      // Even one long tab can overflow once its create action is included.
      if (items.length === 1 && actionWidth) { setCapacity(0); return; }
      // Reserve the menu and the widest tab so any selection fits without reshuffling all tabs.
      let used = 84 + Math.max(0, ...widths);
      let count = 1;
      for (const width of widths) {
        if (used + width + 2 > available) break;
        used += width + 2;
        count += 1;
      }
      setCapacity(Math.max(1, Math.min(count, items.length - 1)));
    };
    measure();
    const schedule = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    const observer = new ResizeObserver(schedule);
    if (container.current) observer.observe(container.current);
    if (actionMeasurement.current) observer.observe(actionMeasurement.current);
    void document.fonts?.ready.then(schedule);
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); };
  }, [signature, items.length, action?.label]);
  const visible = items.slice(0, capacity);
  const selected = items.find(item => item.id === value);
  if (selected && !visible.some(item => item.id === value)) visible.splice(Math.max(0, visible.length - 1), 1, selected);
  const overflow = capacity < items.length;
  React.useEffect(() => { if (!overflow) setOpen(false); }, [overflow]);
  return <div ref={container} className="overflow-tabs">
    <div ref={measurements} className="overflow-tab-measure" aria-hidden="true">
      {items.map(item => <span key={item.id}>{item.label}</span>)}
    </div>
    {action && <span ref={actionMeasurement} className="btn control-ghost overflow-tabs-action overflow-tabs-action-measure" aria-hidden="true">
      <Plus aria-hidden="true" /><span>{action.label}</span>
    </span>}
    <Group className="overflow-tabs-surface" aria-label={label}>
    <TabsList id={id} aria-label={label} className="overflow-tabs-list">
      {visible.map(item => <TabsTab key={item.id} value={item.id} id={tabId?.(item.id)}
        {...(tabData ? { [tabData]: item.id } : {})} disabled={disabled} title={item.label}
        onClick={() => { if (item.id === value) onSelect(item.id); }}><span>{item.label}</span></TabsTab>)}
    </TabsList>
    {overflow && <Combobox items={items} value={selected ?? null} itemToStringLabel={item => item.label}
      isItemEqualToValue={(a, b) => a.id === b.id} open={open} inputValue={query}
      onInputValueChange={setQuery} onOpenChange={next => { setOpen(next); if (next) setQuery(''); }}
      onValueChange={item => { if (item) { onSelect(item.id); setOpen(false); } }}>
      <ComboboxPrimitive.Trigger render={<Button variant="ghost" />} className="overflow-tabs-more" disabled={disabled} aria-label={t('更多{0}', label)}>
        {t('更多')}<ChevronDown size={13} aria-hidden="true" />
      </ComboboxPrimitive.Trigger>
      <ComboboxPopup className="overflow-tabs-popup" initialFocus={search}>
        <ComboboxInput ref={search} showTrigger={false} aria-label={t('搜索{0}', label)} placeholder={t('搜索…')} />
        <ComboboxEmpty>{t('没有匹配项')}</ComboboxEmpty>
        <ComboboxPrimitive.List className="overflow-tabs-options">
          {(item: OverflowTab) => <ComboboxItem key={item.id} value={item} title={item.label}><span className="overflow-option-label">{item.label}</span></ComboboxItem>}
        </ComboboxPrimitive.List>
        {action && <div className="overflow-tabs-footer">
          <Button id={action.id} variant="ghost" className="overflow-tabs-create" disabled={disabled}
            onClick={() => { setOpen(false); action.onClick(); }}>
            <Plus aria-hidden="true" /><span>{action.label}</span>
          </Button>
        </div>}
      </ComboboxPopup>
    </Combobox>}
    {!overflow && action && <Button id={action.id} variant="ghost" className="overflow-tabs-action"
      disabled={disabled} onClick={action.onClick}>
      <Plus aria-hidden="true" /><span>{action.label}</span>
    </Button>}
    </Group>
  </div>;
}
