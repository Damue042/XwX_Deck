import * as React from 'react';
import { cn } from '@/lib/utils';

/** The COSS Group composition, styled with the existing application surface. */
export function Group({ className, ...props }: React.ComponentPropsWithRef<'div'>): React.ReactElement {
  return <div role="group" data-slot="group" className={cn('control-group', className)} {...props} />;
}
