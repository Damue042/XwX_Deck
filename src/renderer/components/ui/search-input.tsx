import * as React from 'react';
import { Input, type InputProps } from './input';
import { cn } from '@/lib/utils';

/** Shared search appearance; callers own filtering and the query. */
export function SearchInput({ label, placeholder = label, className, ...props }:
  Omit<InputProps, 'type' | 'aria-label' | 'nativeInput' | 'className'> & { label: string; className?: string }): React.ReactElement {
  return <Input {...props} nativeInput type="search" aria-label={label} placeholder={placeholder}
    className={cn('control-search', className)} />;
}
