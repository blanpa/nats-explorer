// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { HistorySeries } from 'shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChartPanel, { type ChartSettings } from './ChartPanel';

const series = (field: string, base: number): HistorySeries => ({
  subject: 'plant.robot',
  field,
  points: [
    [1000, base],
    [2000, base + 1],
    [3000, base + 2],
  ],
  samples: 3,
  last: 3000,
});

const settings: ChartSettings = { type: 'line', layout: 'separate', agg: 'minmax', normalize: true };

const panel = (over: Partial<Parameters<typeof ChartPanel>[0]> = {}) => {
  const onSettings = vi.fn();
  const onRemove = vi.fn();
  const view = render(
    <ChartPanel
      fields={['x', 'y']}
      messages={[]}
      seriesByField={{ x: series('x', 400), y: series('y', -60) }}
      settings={settings}
      onSettings={onSettings}
      onRemove={onRemove}
      onClear={vi.fn()}
      {...over}
    />,
  );
  return { ...view, onSettings, onRemove };
};

beforeEach(() => localStorage.clear());

describe('ChartPanel', () => {
  it('draws one chart per field until told otherwise', () => {
    panel();
    // The charts are the svgs with a role; the icons in the chips are not.
    expect(screen.getAllByRole('img')).toHaveLength(2);
    expect(screen.getByRole('img', { name: /^x over time/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^y over time/ })).toBeInTheDocument();
    // Separate charts each keep their own axis, so nothing needs scaling and
    // the question is not even asked.
    expect(screen.queryByRole('checkbox', { name: /Scale each field/ })).not.toBeInTheDocument();
  });

  it('puts every field in one chart when asked, and offers to scale them', () => {
    panel({ settings: { ...settings, layout: 'overlay' } });
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'x, y over time' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Scale each field/ })).toBeChecked();
  });

  it('keeps the settings out of the way of adding a field', () => {
    panel();
    const agg = screen.getByRole('button', { name: 'Min/Max' });
    const chip = screen.getByRole('button', { name: 'Stop charting x' });
    // The settings stand above the chips, so a chip more -- or a row of
    // them -- cannot push them down while the reader is aiming at them.
    expect(agg.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And the control that exists only from the second field on stands at
    // the left of a group that hangs right, so its appearing moves nothing.
    const layout = screen.getByRole('button', { name: 'Separate' });
    expect(layout.compareDocumentPosition(agg) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers the layout only when there is something to lay out', () => {
    panel({ fields: ['x'], seriesByField: { x: series('x', 400) } });
    expect(screen.queryByRole('button', { name: 'One chart' })).not.toBeInTheDocument();
  });

  it('reports a change of aggregation, and says what the chosen one means', () => {
    const { onSettings } = panel();
    // The hint is the point of the control: min/max, average and rate are
    // different questions, and the labels alone do not say which.
    expect(screen.getByText(/never hides an outlier/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Rate/s' }));
    expect(onSettings).toHaveBeenCalledWith({ agg: 'rate' });
  });

  it('drops one field without touching the others', () => {
    const { onRemove } = panel();
    fireEvent.click(screen.getByRole('button', { name: 'Stop charting y' }));
    expect(onRemove).toHaveBeenCalledWith('y');
  });

  it('renders nothing when no field is charted', () => {
    const { container } = panel({ fields: [], seriesByField: {} });
    expect(container).toBeEmptyDOMElement();
  });
});
