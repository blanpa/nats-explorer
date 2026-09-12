import type { Connz, Healthz, Jsz, Leafz, Routez, Subsz, Varz } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { recordSample } from './history';

/** One round of the monitoring endpoints; varz is required, the rest may fail individually. */
export interface Snapshot {
  varz: Varz | null;
  jsz: Jsz | null;
  connz: Connz | null;
  subsz: Subsz | null;
  healthz: Healthz | null;
  routez: Routez | null;
  leafz: Leafz | null;
  errors: string[];
}

export async function loadSnapshot(connId: string): Promise<Snapshot> {
  const [varz, jsz, connz, subsz, healthz, routez, leafz] = await Promise.allSettled([
    api.getMonitoring<Varz>(connId, 'varz'),
    api.getMonitoring<Jsz>(connId, 'jsz'),
    api.getMonitoring<Connz>(connId, 'connz', { limit: 200, sort: 'msgs_from' }),
    api.getMonitoring<Subsz>(connId, 'subsz'),
    api.getMonitoring<Healthz>(connId, 'healthz'),
    api.getMonitoring<Routez>(connId, 'routez'),
    api.getMonitoring<Leafz>(connId, 'leafz'),
  ]);
  const val = <T>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : null);
  const errors = [varz, jsz, connz, subsz, healthz, routez, leafz]
    .filter(r => r.status === 'rejected')
    .map(r => errorMessage((r as PromiseRejectedResult).reason));
  if (varz.status === 'rejected') throw varz.reason;
  recordSample(connId, varz.value, val(jsz));
  return { varz: val(varz), jsz: val(jsz), connz: val(connz), subsz: val(subsz), healthz: val(healthz), routez: val(routez), leafz: val(leafz), errors };
}
