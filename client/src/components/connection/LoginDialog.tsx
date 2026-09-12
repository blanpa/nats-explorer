import { useState } from 'react';
import { KeyRound, LogIn } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { wsClient } from '../../lib/ws';
import { useStore } from '../../store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Input';
import { SourceLink } from '../ui/SourceLink';

/**
 * Shown when the backend wants a login: a token with AUTH_TOKEN, a user and
 * password with AUTH_USERS. The backend answers with a session cookie.
 */
export default function LoginDialog() {
  const required = useAuth(s => s.required);
  const mode = useAuth(s => s.mode);
  const login = useAuth(s => s.login);
  const bump = useStore(s => s.bumpRefresh);
  const [user, setUser] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const users = mode === 'users';
  const ready = secret.trim().length > 0 && (!users || user.trim().length > 0);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(users ? { user: user.trim(), password: secret } : { token: secret.trim() });
      setSecret('');
      wsClient.reset();
      bump();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={required}
      onOpenChange={() => undefined}
      title={users ? 'Sign in' : 'API token required'}
      description={
        users
          ? 'This NATS Explorer backend asks for an account. Viewers can look at everything; admins can also publish and change things.'
          : 'This NATS Explorer backend is protected with AUTH_TOKEN. Enter the token to continue; the session lasts a day.'
      }
      width="sm"
      footer={
        <>
          <SourceLink className="text-xs mr-auto" showLicense />
          <Button variant="primary" icon={users ? <LogIn size={13} /> : <KeyRound size={13} />} disabled={!ready || busy} onClick={submit}>
            {users ? 'Sign in' : 'Unlock'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}
      >
        {users && (
          <Field label="User">
            <Input autoFocus value={user} onChange={e => setUser(e.target.value)} autoComplete="username" />
          </Field>
        )}
        <Field label={users ? 'Password' : 'Token'}>
          <Input
            type="password"
            mono={!users}
            autoFocus={!users}
            value={secret}
            onChange={e => setSecret(e.target.value)}
            autoComplete={users ? 'current-password' : 'off'}
          />
        </Field>
        {error && (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
