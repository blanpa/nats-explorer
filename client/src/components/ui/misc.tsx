import * as RadixTooltip from '@radix-ui/react-tooltip';
import { Loader2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/* Badge ---------------------------------------------------------------- */

export type BadgeTone = 'neutral' | 'accent' | 'info' | 'ok' | 'warn' | 'danger';

export function Badge({
  tone = 'neutral',
  mono,
  className,
  children,
  title,
}: {
  tone?: BadgeTone;
  mono?: boolean;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={cn('badge', `badge-${tone}`, mono && 'font-mono', className)} title={title}>
      {children}
    </span>
  );
}

/* Spinner -------------------------------------------------------------- */

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cn('animate-spin text-muted', className)} />;
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 h-full min-h-[120px] text-sm text-muted">
      <Spinner size={14} /> {label}
    </div>
  );
}

/* Empty state ---------------------------------------------------------- */

export function EmptyState({
  title,
  description,
  action,
  className,
  compact,
}: {
  /** accepted for call-site compatibility; empty states are text-only */
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center h-full', compact ? 'py-6 px-4' : 'py-10 px-6', className)}>
      <div className="text-sm font-medium text-muted">{title}</div>
      {description && <div className="text-xs text-faint mt-1 max-w-[360px] leading-relaxed">{description}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/* Error state ---------------------------------------------------------- */

export function ErrorState({ title = 'Something went wrong', message, action }: { title?: string; message?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center h-full py-10 px-6">
      <div className="text-md font-medium text-danger">{title}</div>
      {message && <div className="text-sm text-muted mt-1 max-w-[420px] font-mono break-words">{message}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* Stat strip --------------------------------------------------------- */

/** A row of figures separated by hairlines; no boxes. */
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-stretch gap-y-3', className)}>{children}</div>;
}

export function StatTile({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'ok' | 'warn' | 'danger' | 'accent';
  className?: string;
}) {
  return (
    <div data-stat="" className={cn('min-w-0 pl-4 pr-6 border-l border-line first:border-l-0 first:pl-0', className)}>
      <div className="text-xs text-muted truncate">{label}</div>
      <div
        className={cn(
          'text-md font-semibold font-mono tabular-nums truncate',
          tone === 'ok' && 'text-ok',
          tone === 'warn' && 'text-warn',
          tone === 'danger' && 'text-danger',
          tone === 'accent' && 'text-accent',
        )}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-faint truncate">{sub}</div>}
    </div>
  );
}

/* Key/value grid ------------------------------------------------------- */

export interface KvItem {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  span?: boolean;
}

export function KeyValueGrid({ items, columns = 2, className }: { items: KvItem[]; columns?: 1 | 2 | 3; className?: string }) {
  return (
    <dl
      className={cn(
        'grid gap-x-6 gap-y-2',
        columns === 1 && 'grid-cols-1',
        columns === 2 && 'grid-cols-1 md:grid-cols-2',
        columns === 3 && 'grid-cols-1 md:grid-cols-3',
        className,
      )}
    >
      {items.map((it, i) => (
        <div key={i} className={cn('flex items-baseline justify-between gap-3 min-w-0 border-b border-line/60 pb-1.5', it.span && 'md:col-span-full')}>
          <dt className="text-xs text-muted shrink-0">{it.label}</dt>
          <dd className={cn('text-sm text-fg text-right truncate min-w-0', it.mono && 'font-mono')} title={typeof it.value === 'string' ? it.value : undefined}>
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* Pane header ---------------------------------------------------------- */

export function PaneHeader({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('pane-header', className)}>
      {title && <span className="pane-title truncate">{title}</span>}
      {children}
      {actions && <div className="ml-auto flex items-center gap-1 shrink-0">{actions}</div>}
    </div>
  );
}

export function SectionTitle({ children, actions, className }: { children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 mb-2', className)}>
      <h3 className="section-title">{children}</h3>
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </div>
  );
}

/* Tabs ----------------------------------------------------------------- */

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  count?: number;
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: TabItem<T>[]; value: T; onChange: (id: T) => void; className?: string }) {
  return (
    <div role="tablist" className={cn('flex items-center gap-0.5 border-b border-line', className)}>
      {tabs.map(t => (
        <button
          type="button"
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            'relative px-3 h-9 text-sm whitespace-nowrap transition-colors -mb-px border-b-2',
            value === t.id ? 'text-fg border-accent' : 'text-muted border-transparent hover:text-fg',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 text-xs text-faint font-mono">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* Segmented control ------------------------------------------------------ */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'sm',
}: {
  options: { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  size?: 'xs' | 'sm';
}) {
  return (
    <div className="inline-flex items-center rounded border border-line bg-panel p-0.5 gap-0.5">
      {options.map(o => (
        <button
          type="button"
          key={o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded-sm transition-colors whitespace-nowrap',
            size === 'xs' ? 'px-2 h-5 text-xs' : 'px-2.5 h-6 text-sm',
            value === o.id ? 'bg-field text-fg shadow-card' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* Tooltip -------------------------------------------------------------- */

export function Tooltip({ content, children, side = 'right' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <RadixTooltip.Root delayDuration={300}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className="z-[70] rounded border border-line bg-raised px-2 py-1 text-xs text-fg shadow-pop animate-fade-in"
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

export const TooltipProvider = RadixTooltip.Provider;

/* Kbd ------------------------------------------------------------------ */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
