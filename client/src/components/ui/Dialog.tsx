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
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[1px] data-[state=open]:animate-fade" />
        <RadixDialog.Content
          className={cn(
            'fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-32px)] max-h-[calc(100vh-40px)]',
            'flex flex-col rounded-lg border border-line bg-panel shadow-pop outline-none data-[state=open]:animate-dialog-in',
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

/**
 * One way out of a choice dialog. Several of them turn the question from
 * "are you sure" into "which one", which is what an action with more than
 * one possible scope needs: guessing the scope for the user is how a button
 * meant for one subject ends up clearing everything.
 */
export interface ChoiceAction {
  key: string;
  label: string;
  danger?: boolean;
  /** The one the dialog opens on; the safest, not the widest. */
  primary?: boolean;
}

interface ChoiceOptions {
  title: string;
  message?: ReactNode;
  cancelLabel?: string;
  actions: ChoiceAction[];
}

interface ConfirmState {
  pending: (ChoiceOptions & { resolve: (key: string | null) => void }) | null;
  ask: (opts: ChoiceOptions) => Promise<string | null>;
  settle: (key: string | null) => void;
}

const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  ask: opts =>
    new Promise<string | null>(resolve => {
      get().pending?.resolve(null);
      set({ pending: { ...opts, resolve } });
    }),
  settle: key => {
    get().pending?.resolve(key);
    set({ pending: null });
  },
}));

/** A yes/no question. */
export const confirm = async (opts: ConfirmOptions): Promise<boolean> => {
  const key = await useConfirmStore.getState().ask({
    title: opts.title,
    message: opts.message,
    cancelLabel: opts.cancelLabel,
    actions: [{ key: 'ok', label: opts.confirmLabel ?? 'Confirm', danger: opts.danger, primary: true }],
  });
  return key === 'ok';
};

/** A question with more than one answer; resolves to the chosen key, or null. */
export const choose = (opts: ChoiceOptions) => useConfirmStore.getState().ask(opts);

export function ConfirmHost() {
  const pending = useConfirmStore(s => s.pending);
  const settle = useConfirmStore(s => s.settle);
  const actions = pending?.actions ?? [];
  // With one action the cancel button is the safe default; with a choice the
  // dialog opens on the action marked primary, so Enter takes the narrow one.
  const autoFocusCancel = actions.length === 1 && !actions[0].danger;
  return (
    <Dialog
      open={!!pending}
      onOpenChange={open => !open && settle(null)}
      title={pending?.title ?? ''}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(null)} autoFocus={autoFocusCancel}>
            {pending?.cancelLabel ?? 'Cancel'}
          </Button>
          {actions.map(a => (
            <Button
              key={a.key}
              variant={a.danger ? 'danger-solid' : 'primary'}
              onClick={() => settle(a.key)}
              autoFocus={!autoFocusCancel && (a.primary ?? false)}
            >
              {a.label}
            </Button>
          ))}
        </>
      }
    >
      <div className="text-sm text-muted">{pending?.message}</div>
    </Dialog>
  );
}
