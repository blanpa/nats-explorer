import { useRef } from 'react';
import { AlertTriangle, Upload } from 'lucide-react';
import type { AuthMethod, ConnectionStatus } from 'shared';
import type { SavedConnection } from '../../lib/savedConnections';
import { appInfo } from '../../lib/storage';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '../ui/Input';
import { Badge, Hint } from '../ui/misc';

const AUTH_OPTIONS: { value: AuthMethod; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'token', label: 'Token' },
  { value: 'userpass', label: 'Username / Password' },
  { value: 'nkey', label: 'NKey seed' },
  { value: 'jwt', label: 'Credentials file (JWT)' },
];

/** Summarises what a PEM blob contains, e.g. "1 CERTIFICATE". */
function describePem(pem: string): string {
  const kinds = new Map<string, number>();
  for (const m of pem.matchAll(/-----BEGIN ([A-Z ]+)-----/g)) kinds.set(m[1], (kinds.get(m[1]) ?? 0) + 1);
  if (kinds.size === 0) return 'no PEM block found';
  return [...kinds].map(([k, n]) => `${n} ${k}`).join(', ');
}

function PemField({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-col gap-1">
        <Textarea rows={3} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="text-xs" spellCheck={false} />
        <div className="flex items-center gap-1 text-xs">
          <Button size="xs" variant="ghost" icon={<Upload size={12} />} onClick={() => fileRef.current?.click()}>
            Load file…
          </Button>
          {value.trim() && (
            <Button size="xs" variant="ghost" onClick={() => onChange('')}>
              Clear
            </Button>
          )}
          {value.trim() && <span className={cn('ml-auto truncate', /BEGIN/.test(value) ? 'text-faint' : 'text-warn')}>{describePem(value)}</span>}
          <input
            ref={fileRef}
            type="file"
            accept=".pem,.crt,.cer,.key,.txt,application/x-pem-file,application/x-x509-ca-cert"
            className="hidden"
            onChange={async e => {
              const f = e.target.files?.[0];
              if (f) onChange(await f.text());
              e.target.value = '';
            }}
          />
        </div>
      </div>
    </Field>
  );
}

/** Credentials for one auth method; `prefix` switches to the system-account fields. */
function AuthFields({ draft, patch, system }: { draft: SavedConnection; patch: (p: Partial<SavedConnection>) => void; system?: boolean }) {
  const method = system ? (draft.sysAuthMethod ?? 'none') : draft.authMethod;
  const label = (s: string) => (system ? `System ${s.toLowerCase()}` : s);
  if (method === 'token')
    return (
      <Field label={label('Token')}>
        <Input
          type="password"
          mono
          value={(system ? draft.sysToken : draft.token) ?? ''}
          onChange={e => patch(system ? { sysToken: e.target.value } : { token: e.target.value })}
          autoComplete="off"
        />
      </Field>
    );
  if (method === 'userpass')
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label={label('Username')}>
          <Input
            value={(system ? draft.sysUser : draft.user) ?? ''}
            onChange={e => patch(system ? { sysUser: e.target.value } : { user: e.target.value })}
            autoComplete="off"
          />
        </Field>
        <Field label={label('Password')}>
          <Input
            type="password"
            value={(system ? draft.sysPass : draft.pass) ?? ''}
            onChange={e => patch(system ? { sysPass: e.target.value } : { pass: e.target.value })}
            autoComplete="new-password"
          />
        </Field>
      </div>
    );
  if (method === 'nkey')
    return (
      <Field label={label('NKey seed')} hint="User seed starting with SU…">
        <Input
          type="password"
          mono
          value={(system ? draft.sysNkeySeed : draft.nkeySeed) ?? ''}
          onChange={e => patch(system ? { sysNkeySeed: e.target.value } : { nkeySeed: e.target.value })}
          placeholder="SUA…"
          autoComplete="off"
        />
      </Field>
    );
  if (method === 'jwt')
    return (
      <Field label={label('Credentials file content')} hint="The whole .creds file.">
        <Textarea
          rows={system ? 4 : 5}
          value={(system ? draft.sysCreds : draft.creds) ?? ''}
          onChange={e => patch(system ? { sysCreds: e.target.value } : { creds: e.target.value })}
          placeholder="-----BEGIN NATS USER JWT-----"
        />
      </Field>
    );
  return null;
}

interface Props {
  draft: SavedConnection;
  isNew: boolean;
  live: ConnectionStatus | undefined;
  patch: (p: Partial<SavedConnection>) => void;
  onSubmit: () => void;
}

/** Every field of a saved connection: servers, auth, monitoring, JetStream, system account, TLS. */
export default function ConnectionForm({ draft, isNew, live, patch, onSubmit }: Props) {
  return (
    <form
      className="flex-1 min-w-0 overflow-auto px-5 py-4 flex flex-col gap-4"
      onSubmit={e => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {live && (
        <div className="flex items-center gap-2 text-sm">
          <Badge tone={live.connected ? 'ok' : 'warn'}>{live.connected ? 'Connected' : live.reconnecting ? 'Reconnecting' : 'Disconnected'}</Badge>
          {live.server && <span className="text-xs text-muted font-mono">{live.server}</span>}
          {live.lastError && <span className="text-xs text-danger font-mono truncate">{live.lastError}</span>}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Name">
          <Input value={draft.name} onChange={e => patch({ name: e.target.value })} placeholder="Production cluster" autoFocus={isNew} />
        </Field>
        <Field label="Authentication">
          <Select value={draft.authMethod} onChange={e => patch({ authMethod: e.target.value as AuthMethod })}>
            {AUTH_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Servers" hint="One per line or comma separated." required>
        <Textarea
          rows={2}
          value={draft.servers.join('\n')}
          onChange={e => patch({ servers: e.target.value.split('\n') })}
          placeholder="nats://localhost:4222"
        />
      </Field>

      <AuthFields draft={draft} patch={patch} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Monitoring URL" hint="Defaults to port 8222 of the first server.">
          <Input mono value={draft.monitoringUrl ?? ''} onChange={e => patch({ monitoringUrl: e.target.value })} placeholder="http://localhost:8222" />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted">Transport</span>
          <Checkbox
            label="Use TLS"
            description="Required for tls:// servers with certificates."
            checked={!!draft.tls}
            onChange={e => patch({ tls: e.target.checked })}
          />
          {appInfo.storage === 'file' && (
            <Checkbox
              label="Connect when the server starts"
              description="The backend opens this connection on start, so history and metrics collect without a browser."
              checked={!!draft.autoConnect}
              onChange={e => patch({ autoConnect: e.target.checked })}
            />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="JetStream domain" hint="Optional, e.g. the domain of a leaf node.">
          <Input mono value={draft.jsDomain ?? ''} onChange={e => patch({ jsDomain: e.target.value })} placeholder="leaf-a" />
        </Field>
        <Field label="JetStream API prefix" hint="Optional, wins over the domain.">
          <Input mono value={draft.jsApiPrefix ?? ''} onChange={e => patch({ jsApiPrefix: e.target.value })} placeholder="$JS.leaf-a.API" />
        </Field>
      </div>

      <p className="text-xs text-muted">
        <Hint
          className="mr-1"
          text="Subjects and system subjects ($SYS, $JS, $KV, $SRV) are chosen in the Subjects pane while connected, and remembered here."
        />
        Subscriptions: <span className="font-mono text-fg">{draft.subscriptions.length ? draft.subscriptions.join(', ') : 'none'}</span>
      </p>

      <div className="flex flex-col gap-3 rounded border border-line p-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="System account" hint="$SYS credentials enable the Cluster module.">
            <Select value={draft.sysAuthMethod ?? 'none'} onChange={e => patch({ sysAuthMethod: e.target.value as AuthMethod })}>
              {AUTH_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.value === 'none' ? 'Not configured' : o.label}
                </option>
              ))}
            </Select>
          </Field>
          <AuthFields draft={draft} patch={patch} system />
        </div>
        {live?.sysError && <span className="text-xs text-danger">System account: {live.sysError}</span>}
        {live?.sysAccount && <span className="text-xs text-ok">System account connected.</span>}
      </div>

      {draft.tls && (
        <div className="flex flex-col gap-3 rounded border border-line p-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <PemField
              label="CA certificate"
              hint="Instead of the system store."
              value={draft.tlsCa ?? ''}
              onChange={v => patch({ tlsCa: v })}
              placeholder="-----BEGIN CERTIFICATE-----"
            />
            <PemField
              label="Client certificate"
              hint="Mutual TLS, with the key."
              value={draft.tlsCert ?? ''}
              onChange={v => patch({ tlsCert: v })}
              placeholder="-----BEGIN CERTIFICATE-----"
            />
            <PemField label="Client key" value={draft.tlsKey ?? ''} onChange={v => patch({ tlsKey: v })} placeholder="-----BEGIN PRIVATE KEY-----" />
          </div>
          <Checkbox
            label="Skip server certificate verification"
            description="Insecure: accepts any server certificate. Only for test environments."
            checked={!!draft.tlsInsecure}
            onChange={e => patch({ tlsInsecure: e.target.checked })}
          />
          <Checkbox
            label="TLS handshake first"
            description="For servers configured with handshake_first: TLS is negotiated before the server sends its INFO."
            checked={!!draft.tlsFirst}
            onChange={e => patch({ tlsFirst: e.target.checked })}
          />
        </div>
      )}

      <div className="flex items-start gap-2 text-xs text-muted rounded border border-warn/30 bg-warn/5 px-3 py-2 mt-auto">
        <AlertTriangle size={13} className="text-warn shrink-0 mt-0.5" />
        <span>
          {appInfo.storage === 'file' ? (
            <>
              Connections are stored in <span className="font-mono">{appInfo.configDir}</span>. Tokens, passwords, seeds and TLS keys go to{' '}
              {appInfo.secrets === 'keyring' ? (
                'the system keyring'
              ) : (
                <>
                  a separate <span className="font-mono">secrets.json</span> readable only by your user account
                </>
              )}
              .
            </>
          ) : (
            <>
              Tokens, passwords, seeds and TLS keys are saved in this browser&apos;s local storage without encryption and sent to the NATS Explorer backend on
              connect. Do not use this on a shared machine with production credentials.
            </>
          )}
        </span>
      </div>
    </form>
  );
}
