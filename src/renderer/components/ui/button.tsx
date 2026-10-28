import * as React from 'react';
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cn } from '@/lib/utils';

/** Shared text labels let CSS align the rendered glyphs, including plain-string children. */
export function Button({ variant = 'outline', size = 'default', className, children, ...props }:
  Omit<ButtonPrimitive.Props, 'className'> & { variant?: 'default' | 'outline' | 'ghost' | 'danger'; size?: 'default' | 'sm' | 'icon'; className?: string }): React.ReactElement {
  return <ButtonPrimitive data-slot="button" className={cn('btn', variant === 'default' && 'primary',
    variant === 'ghost' && 'control-ghost', variant === 'danger' && 'danger',
    size === 'icon' && 'control-icon', size === 'sm' && 'control-small', className)} {...props}>
    {React.Children.map(children, child => typeof child === 'number' || typeof child === 'string' && child.trim()
      ? <span data-slot="button-label">{child}</span> : child)}
  </ButtonPrimitive>;
}
