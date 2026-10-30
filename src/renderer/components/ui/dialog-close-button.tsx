import type * as React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';

type Props = Omit<React.ComponentProps<typeof Dialog.Close>, 'children' | 'render' | 'className'> & {
  className?: string;
};

/** Balance the X visually with adjacent icons while keeping its stroke weight. */
export function DialogCloseButton({ className, ...props }: Props): React.ReactElement {
  return <Dialog.Close {...props} render={<Button variant="ghost" size="icon" />} className={cn('dialog-close-button', className)}>
    <X className="dialog-close-glyph" size={20} strokeWidth={1.6} aria-hidden="true" />
  </Dialog.Close>;
}
