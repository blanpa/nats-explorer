import { formatBytes, formatNumber } from '../../lib/utils';
import { SectionTitle } from '../ui/misc';
import { RateChart } from '../ui/RateChart';
import { gaugeSeries, rateSeries, samplesFor } from './history';

const COLORS = { in: 'rgb(var(--accent))', out: 'rgb(var(--info))', warn: 'rgb(var(--warn))', danger: 'rgb(var(--danger))' };
const perSec = (v: number) => `${v > 0 && v < 10 ? v.toFixed(1) : formatNumber(Math.round(v))}/s`;
const whole = (v: number) => formatNumber(Math.round(v));
const bytesPerSec = (v: number) => `${formatBytes(v)}/s`;

/** Rate and gauge curves from the samples collected on every refresh. */
export default function Throughput({ connId }: { connId: string }) {
  const samples = samplesFor(connId);
  const msgsIn = rateSeries(samples, s => s.inMsgs);
  const msgsOut = rateSeries(samples, s => s.outMsgs);
  const bytesIn = rateSeries(samples, s => s.inBytes);
  const bytesOut = rateSeries(samples, s => s.outBytes);
  const conns = gaugeSeries(samples, s => s.connections);
  const subs = gaugeSeries(samples, s => s.subscriptions);
  const cpu = gaugeSeries(samples, s => s.cpu);
  const api = rateSeries(samples, s => s.jsApiTotal);
  const apiErr = rateSeries(samples, s => s.jsApiErrors);
  const slow = gaugeSeries(samples, s => s.slowConsumers);
  const span = samples.length > 1 ? Math.round((samples[samples.length - 1].t - samples[0].t) / 60000) : 0;
  return (
    <div>
      <SectionTitle>
        Throughput
        {span > 0 && <span className="font-normal text-faint ml-2">last {span < 1 ? '<1' : span} min</span>}
      </SectionTitle>
      {samples.length < 2 ? (
        <div className="text-xs text-muted py-2">Collecting samples, the curves appear with the next refresh.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-4">
          <RateChart
            title="Messages per second"
            times={msgsIn.times}
            series={[
              { label: 'in', color: COLORS.in, values: msgsIn.values },
              { label: 'out', color: COLORS.out, values: msgsOut.values },
            ]}
            format={perSec}
          />
          <RateChart
            title="Bytes per second"
            times={bytesIn.times}
            series={[
              { label: 'in', color: COLORS.in, values: bytesIn.values },
              { label: 'out', color: COLORS.out, values: bytesOut.values },
            ]}
            format={bytesPerSec}
          />
          <RateChart
            title="JetStream API"
            times={api.times}
            series={[
              { label: 'calls', color: COLORS.in, values: api.values },
              { label: 'errors', color: COLORS.danger, values: apiErr.values },
            ]}
            format={perSec}
          />
          <RateChart
            title="Client connections"
            times={conns.times}
            series={[
              { label: 'clients', color: COLORS.in, values: conns.values },
              { label: 'slow', color: COLORS.warn, values: slow.values },
            ]}
            format={whole}
          />
          <RateChart title="Subscriptions" times={subs.times} series={[{ label: 'total', color: COLORS.out, values: subs.values }]} format={whole} />
          <RateChart title="CPU" times={cpu.times} series={[{ label: 'cpu', color: COLORS.warn, values: cpu.values }]} format={v => `${v.toFixed(1)}%`} />
        </div>
      )}
    </div>
  );
}
