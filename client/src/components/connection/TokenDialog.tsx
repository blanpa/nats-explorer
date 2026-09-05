import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { wsClient } from '../../lib/ws';
import { useStore } from '../../store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Input';

/** Shown when the backend runs with AUTH_TOKEN and no valid token is known. */
export default function TokenDialog() {
  const required = useAuth(s => s.required);
  const setToken = useAuth(s => s.setToken);
  const bump = useStore(s => s.bumpRefresh);
  const [value, setValue] = useState('');

  const submit = () => {
    if (!value.trim()) return;
    setToken(value.trim());
    setValue('');
    wsClient.reset();
    bump();
  };

  return (
    <Dialog
      open={required}
      onOpenChange={() => undefined}
      title="API token required"
      description="This NATS Explorer backend is protected with AUTH_TOKEN. Enter the token to continue; it is kept for this browser tab only."
      width="sm"
      footer={
        <Button variant="primary" icon={<KeyRound size={13} />} disabled={!value.trim()} onClick={submit}>
          Unlock
        </Button>
      }
    >
      <form
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Token">
          <Input type="password" mono autoFocus value={value} onChange={e => setValue(e.target.value)} autoComplete="off" />
        </Field>
      </form>
    </Dialog>
  );
}
