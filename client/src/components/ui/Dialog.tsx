import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { create } from 'zustand';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button, IconButton } from './Button';

const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' } as const;

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: keyof typeof widths;
  /** Removes the default body padding, for dialogs that manage their own layout. */
  flush?: boolean;
  className?: string;
}

export function Dialog({ open, onOpenChange, title, description, children, footer, width = 'md', flush, className }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[1px] data-[state=open]:animate-fade-in" />
        <RadixDialog.Content
          className={cn(
            'fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-32px)] max-h-[calc(100vh-40px)]',
            'flex flex-col rounded-lg border border-line bg-panel shadow-pop outline-none data-[state=open]:animate-fade-in',
            widths[width],
            className,
          )}
        >
          <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-line shrink-0">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-md font-semibold text-fg">{title}</RadixDialog.Title>
              {description && <RadixDialog.Description className="text-sm text-muted mt-0.5">{description}</RadixDialog.Description>}
            </div>
            <RadixDialog.Close asChild>
              <IconButton label="Close" size="sm">
                <X size={15} />
              </IconButton>
            </RadixDialog.Close>
          </div>
          <div className={cn('flex-1 min-h-0 overflow-auto', !flush && 'px-5 py-4')}>{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line shrink-0">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/* ---------------------------------------------------------------------------
 * Confirm dialog (imperative): const ok = await confirm({ ... })
 * ------------------------------------------------------------------------ */

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmState {
  pending: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
  ask: (opts: ConfirmOptions) => Promise<boolean>;
  settle: (ok: boolean) => void;
}

const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  ask: opts =>
    new Promise<boolean>(resolve => {
      get().pending?.resolve(false);
      set({ pending: { ...opts, resolve } });
    }),
  settle: ok => {
    get().pending?.resolve(ok);
    set({ pending: null });
  },
}));

export const confirm = (opts: ConfirmOptions) => useConfirmStore.getState().ask(opts);

export function ConfirmHost() {
  const pending = useConfirmStore(s => s.pending);
  const settle = useConfirmStore(s => s.settle);
  return (
    <Dialog
      open={!!pending}
      onOpenChange={open => !open && settle(false)}
      title={pending?.title ?? ''}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(false)} autoFocus={!pending?.danger}>
            {pending?.cancelLabel ?? 'Cancel'}
          </Button>
          <Button variant={pending?.danger ? 'danger' : 'primary'} onClick={() => settle(true)} autoFocus={pending?.danger}>
            {pending?.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <div className="text-sm text-muted">{pending?.message}</div>
    </Dialog>
  );
}
