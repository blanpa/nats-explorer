import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils';

type Tone = 'info' | 'success' | 'error' | 'warning';

interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  detail?: string;
}

interface ToastState {
  items: ToastItem[];
  push: (t: Omit<ToastItem, 'id'>) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

const useToastStore = create<ToastState>((set, get) => ({
  items: [],
  push: t => {
    const id = ++seq;
    set(s => ({ items: [...s.items.slice(-4), { ...t, id }] }));
    const ttl = t.tone === 'error' ? 8000 : 3500;
    setTimeout(() => get().dismiss(id), ttl);
  },
  dismiss: id => set(s => ({ items: s.items.filter(i => i.id !== id) })),
}));

const push = (tone: Tone) => (title: string, detail?: string) => useToastStore.getState().push({ tone, title, detail });

export const toast = {
  info: push('info'),
  success: push('success'),
  error: push('error'),
  warning: push('warning'),
};

const icons: Record<Tone, typeof Info> = { info: Info, success: CheckCircle2, error: XCircle, warning: AlertTriangle };
const tones: Record<Tone, string> = {
  info: 'text-info',
  success: 'text-ok',
  error: 'text-danger',
  warning: 'text-warn',
};

export function Toaster() {
  const items = useToastStore(s => s.items);
  const dismiss = useToastStore(s => s.dismiss);
  if (items.length === 0) return null;
  return (
    <div className="fixed bottom-8 right-4 z-[60] flex flex-col gap-2 w-[360px] max-w-[calc(100vw-32px)]" role="status" aria-live="polite">
      {items.map(item => {
        const Icon = icons[item.tone];
        return (
          <div key={item.id} className="card shadow-pop flex items-start gap-2.5 px-3 py-2.5 animate-fade-in">
            <Icon size={15} className={cn('mt-0.5 shrink-0', tones[item.tone])} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-fg break-words">{item.title}</div>
              {item.detail && <div className="text-xs text-muted mt-0.5 break-words font-mono">{item.detail}</div>}
            </div>
            <button className="text-faint hover:text-fg shrink-0" onClick={() => dismiss(item.id)} aria-label="Dismiss">
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
