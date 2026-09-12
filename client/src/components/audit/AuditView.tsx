import { useState } from 'react';
import { RefreshCw, ScrollText } from 'lucide-react';
import { type AuditEntry, getAudit, objectOf, statusTone } from '../../lib/api.audit';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/useAsync';
import { formatDateTime } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { Input, Select } from '../ui/Input';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader } from '../ui/misc';

const METHODS = ['', 'POST', 'PUT', 'DELETE'];
const LIMITS = [100, 200, 500, 1000];

/**
 * Who changed what: every write under /api with the account, the object and
 * the result. Reads are not recorded, refused writes are.
 */
export default function AuditView() {
  const mode = useAuth(s => s.mode);
  const role = useAuth(s => s.role);
  const [user, setUser] = useState('');
  const [method, setMethod] = useState('');
  const [limit, setLimit] = useState(200);
  const { data, error, loading, initial, reload } = useAsync<{ entries: AuditEntry[] }>(() => getAudit({ user, method, limit }), [user, method, limit], {
    key: `audit:${user}:${method}:${limit}`,
  });

  const header = (
    <PaneHeader
      title="Audit log"
      actions={
        <IconButton label="Refresh" loading={loading && !initial} onClick={reload}>
          <RefreshCw size={14} />
        </IconButton>
      }
    >
      <div className="flex items-center gap-2 ml-3">
        <Input inputSize="sm" className="w-36" value={user} onChange={e => setUser(e.target.value)} placeholder="User" aria-label="Filter by user" />
        <Select inputSize="sm" value={method} onChange={e => setMethod(e.target.value)} aria-label="Filter by method">
          {METHODS.map(m => (
            <option key={m || 'all'} value={m}>
              {m || 'Any method'}
            </option>
          ))}
        </Select>
        <Select inputSize="sm" value={String(limit)} onChange={e => setLimit(Number(e.target.value))} aria-label="Number of entries">
          {LIMITS.map(n => (
            <option key={n} value={n}>
              last {n}
            </option>
          ))}
        </Select>
      </div>
    </PaneHeader>
  );

  const entries = data?.entries ?? [];

  return (
    <div className="flex flex-col h-full min-h-0">
      {header}
      <div className="flex-1 min-h-0 overflow-auto">
        {initial && loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Audit log unavailable" message={error} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="Nothing recorded yet"
            description={
              mode === 'none'
                ? 'Writes are recorded as soon as they happen; with AUTH_USERS or AUTH_TOKEN they also carry the account.'
                : role === 'admin'
                  ? 'Publishing, creating, editing and deleting show up here.'
                  : 'The audit log needs the admin role.'
            }
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Method</th>
                <th>Object</th>
                <th>Detail</th>
                <th>Connection</th>
                <th className="num">Status</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.time}-${e.path}-${i}`}>
                  <td className="num text-muted whitespace-nowrap">{formatDateTime(e.time)}</td>
                  <td>
                    {e.user || <span className="text-faint">–</span>}
                    {e.role && <span className="text-xs text-faint ml-1">{e.role}</span>}
                  </td>
                  <td className="font-mono text-muted">{e.method}</td>
                  <td className="font-mono">{objectOf(e)}</td>
                  <td className="font-mono text-muted max-w-[320px] truncate" title={`${e.path}${e.summary ? ` · ${e.summary}` : ''}`}>
                    {e.summary || e.path}
                  </td>
                  <td className="font-mono text-muted">{e.connId || <span className="text-faint">–</span>}</td>
                  <td className="num">
                    <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                  </td>
                  <td className="font-mono text-faint">{e.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
