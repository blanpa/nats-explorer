import { describe, expect, it } from 'vitest';
import type { Varz } from 'shared';
import { clearSamples, gaugeSeries, rateSeries, recordSample, samplesFor } from './history';

const varz = (over: Partial<Varz>): Varz =>
  ({ in_msgs: 0, out_msgs: 0, in_bytes: 0, out_bytes: 0, connections: 1, subscriptions: 2, slow_consumers: 0, cpu: 1, mem: 10, ...over }) as Varz;

describe('monitoring history', () => {
  it('turns counters into per-second rates and treats counter drops as zero', () => {
    const s = [
      { t: 0, inMsgs: 100 },
      { t: 5000, inMsgs: 600 },
      { t: 10000, inMsgs: 50 }, // restart
      { t: 12000, inMsgs: 250 },
    ].map(x => ({
      ...x,
      outMsgs: 0,
      inBytes: 0,
      outBytes: 0,
      connections: 0,
      subscriptions: 0,
      slowConsumers: 0,
      cpu: 0,
      mem: 0,
      jsApiTotal: 0,
      jsApiErrors: 0,
    }));
    const r = rateSeries(s, x => x.inMsgs);
    expect(r.times).toEqual([5000, 10000, 12000]);
    expect(r.values).toEqual([100, 0, 100]);
    expect(gaugeSeries(s, x => x.inMsgs)).toEqual({ times: r.times, values: [600, 50, 250] });
  });

  it('records samples per connection and caps the buffer', () => {
    clearSamples('c');
    recordSample('c', varz({ in_msgs: 5 }), { api: { total: 3, errors: 1 } } as never);
    recordSample('c', varz({ in_msgs: 9 }), null); // within 500 ms: ignored
    const got = samplesFor('c');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ inMsgs: 5, jsApiTotal: 3, jsApiErrors: 1, connections: 1 });
    expect(samplesFor('other')).toEqual([]);
  });
});
