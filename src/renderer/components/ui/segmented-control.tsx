import * as React from 'react';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';
import { cn } from '@/lib/utils';

export interface SegmentOption<Value extends string> {
  value: Value;
  label: string;
  count?: number;
  disabled?: boolean;
}

/** A single selection stays selected when pressed again. */
export function SegmentedControl<Value extends string>({ options, value, onValueChange, label, className, disabled }:
  { options: readonly SegmentOption<Value>[]; value: Value; onValueChange: (value: Value) => void;
    label: string; className?: string; disabled?: boolean }): React.ReactElement {
  return <ToggleGroup value={[value]} onValueChange={values => {
    const next = options.find(option => option.value === values[0]);
    if (next) onValueChange(next.value);
  }} aria-label={label} className={cn('control-segmented', className)} disabled={disabled}>
    {options.map(option => <ToggleGroupItem key={option.value} value={option.value} disabled={option.disabled}
      aria-label={option.label}><span className="control-segment-content"><span>{option.label}</span>{value === option.value && option.count !== undefined
        ? <span className="filter-result-count" aria-hidden="true">{option.count}</span> : null}</span></ToggleGroupItem>)}
  </ToggleGroup>;
}
