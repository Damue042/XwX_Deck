import * as React from 'react';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { Toggle } from '@base-ui/react/toggle';
import { cn } from '@/lib/utils';

export function ToggleGroup({ className, ...props }: Omit<ToggleGroupPrimitive.Props, 'className'> & { className?: string }): React.ReactElement {
  return <ToggleGroupPrimitive data-slot="toggle-group" className={cn('control-toggle-group', className)} {...props} />;
}

export function ToggleGroupItem({ className, ...props }: Omit<Toggle.Props, 'className'> & { className?: string }): React.ReactElement {
  return <Toggle data-slot="toggle" className={cn('control-toggle', className)} {...props} />;
}
