import type * as React from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from './button';

/** Shared busy/disabled feedback for icon-only refresh actions. */
export function RefreshButton({ busy, label, size = 16, disabled, className = 'configuration-close', ...props }: Omit<React.ComponentProps<'button'>, 'children' | 'aria-busy'> & {
  busy: boolean;
  label: string;
  size?: number;
}): React.ReactElement {
  return <Button {...props} type="button" variant="ghost" size="icon" className={className} aria-label={label} title={props.title ?? label} aria-busy={busy} disabled={disabled || busy}>
    <RefreshCw size={size} className={busy ? 'configuration-refresh-spinner' : undefined} aria-hidden="true" />
  </Button>;
}
