import type { Jsz, Varz } from 'shared';

/** One monitoring poll, reduced to the counters the charts need. */
export interface Sample {
  t: number;
  inMsgs: number;
  outMsgs: number;
  inBytes: number;
  outBytes: number;
  connections: number;
  subscriptions: number;
  slowConsumers: number;
  cpu: number;
  mem: number;
  jsApiTotal: number;
  jsApiErrors: number;
}

const MAX_SAMPLES = 720; // an hour at 5 s
const histories = new Map<string, Sample[]>();

/** Remembers a poll; kept in memory across module switches so charts have history. */
export function recordSample(connId: string, varz: Varz, jsz: Jsz | null): void {
  const list = histories.get(connId) ?? [];
  const last = list[list.length - 1];
  const t = Date.now();
  if (last && t - last.t < 500) return; // a manual refresh right after a poll
  list.push({
    t,
    inMsgs: varz.in_msgs,
    outMsgs: varz.out_msgs,
    inBytes: varz.in_bytes,
    outBytes: varz.out_bytes,
    connections: varz.connections,
    subscriptions: varz.subscriptions,
    slowConsumers: varz.slow_consumers,
    cpu: varz.cpu ?? 0,
    mem: varz.mem,
    jsApiTotal: jsz?.api?.total ?? 0,
    jsApiErrors: jsz?.api?.errors ?? 0,
  });
  if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
  histories.set(connId, list);
}

export function samplesFor(connId: string): Sample[] {
  return histories.get(connId) ?? [];
}

export function clearSamples(connId: string): void {
  histories.delete(connId);
}

/** Per-second rate between consecutive samples of a monotonic counter; a server restart (counter drop) reads as 0. */
export function rateSeries(samples: Sample[], pick: (s: Sample) => number): { times: number[]; values: number[] } {
  const times: number[] = [];
  const values: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    const d = pick(samples[i]) - pick(samples[i - 1]);
    times.push(samples[i].t);
    values.push(dt > 0 && d >= 0 ? d / dt : 0);
  }
  return { times, values };
}

/** Plain gauge series (connections, cpu …). */
export function gaugeSeries(samples: Sample[], pick: (s: Sample) => number): { times: number[]; values: number[] } {
  return { times: samples.map(s => s.t), values: samples.map(pick) };
}
