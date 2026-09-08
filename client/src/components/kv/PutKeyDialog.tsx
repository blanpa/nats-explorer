import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input, Textarea } from '../ui/Input';

/** Creates or overwrites a key in a bucket. */
export default function PutKeyDialog({
  connId,
  bucket,
  onClose,
  onSaved,
}: {
  connId: string;
  bucket: string;
  onClose: () => void;
  onSaved: (key: string) => void;
}) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = key.trim().length > 0 && !/\s/.test(key);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await api.putKvEntry(connId, bucket, key.trim(), value);
      onSaved(key.trim());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={o => !o && onClose()}
      title={`Put key in ${bucket}`}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger font-mono truncate">{error}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>
            Put
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={ev => {
          ev.preventDefault();
          submit();
        }}
      >
        <Field label="Key" hint="Dots create a hierarchy, e.g. config.db.host" required>
          <Input mono value={key} onChange={ev => setKey(ev.target.value)} autoFocus />
        </Field>
        <Field label="Value">
          <Textarea rows={8} value={value} onChange={ev => setValue(ev.target.value)} placeholder='{"enabled": true}' />
        </Field>
      </form>
    </Dialog>
  );
}
