import { useState } from 'react';
import { Download } from 'lucide-react';
import { bundleUrl } from '../../lib/api.bundle';
import { useStore } from '../../store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input, Select } from '../ui/Input';

const RANGES: { id: string; label: string; ms: number }[] = [
  { id: 'memory', label: 'What is in memory', ms: 0 },
  { id: '1h', label: 'Last hour', ms: 3600_000 },
  { id: '6h', label: 'Last 6 hours', ms: 6 * 3600_000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 3600_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 3600_000 },
];

/**
 * Writes a zip with a range of recorded messages and a snapshot of the
 * server, for someone who has to look into an incident without access to
 * the system. The download link carries the session cookie.
 */
export default function ExportBundleDialog({ connId, onClose, subject: initialSubject = '' }: { connId: string; onClose: () => void; subject?: string }) {
  const historyDb = useStore(s => s.historyDb);
  const [range, setRange] = useState(historyDb ? '1h' : 'memory');
  const [subject, setSubject] = useState(initialSubject);
  const chosen = RANGES.find(r => r.id === range) ?? RANGES[0];
  const from = chosen.ms ? Date.now() - chosen.ms : 0;

  return (
    <Dialog
      open
      onOpenChange={o => !o && onClose()}
      title="Export support bundle"
      description="One file with the recorded messages, the server snapshot and the JetStream overview. It can be opened again in any explorer."
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Download size={13} />}
            onClick={() => {
              // A plain navigation: the backend streams the zip as a download.
              window.location.href = bundleUrl({ connId, from, subject });
              onClose();
            }}
          >
            Download
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Range" hint={historyDb ? undefined : 'Without a persistent history only what is in memory can be exported.'}>
          <Select value={range} onChange={e => setRange(e.target.value)}>
            {RANGES.map(r => (
              <option key={r.id} value={r.id} disabled={!historyDb && r.ms > 0}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Subject" hint="Optional: this subject and everything below it. Empty exports every subject.">
          <Input mono value={subject} onChange={e => setSubject(e.target.value)} placeholder="plant.line1" />
        </Field>
      </div>
    </Dialog>
  );
}
