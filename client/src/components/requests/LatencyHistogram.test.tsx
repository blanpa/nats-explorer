// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import LatencyHistogram, { bucketLabel } from './LatencyHistogram';

describe('bucketLabel', () => {
  it('names the bound, and the overflow bucket by what it means', () => {
    expect(bucketLabel({ le: 5, count: 1 })).toBe('≤ 5.00ms');
    expect(bucketLabel({ le: 0, count: 1 })).toBe('slower');
  });
});

describe('LatencyHistogram', () => {
  it('renders one bar per bucket with its share in the title', () => {
    render(
      <LatencyHistogram
        buckets={[
          { le: 1, count: 3 },
          { le: 5, count: 0 },
          { le: 0, count: 1 },
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: 'Reply latency distribution' })).toBeInTheDocument();
    expect(screen.getByTitle(/^3 of 4 ≤ /)).toBeInTheDocument();
    expect(screen.getByTitle('1 of 4 slower')).toBeInTheDocument();
    expect(screen.getByTitle(/^0 of 4 ≤ /)).toBeInTheDocument();
  });

  it('renders nothing when no reply arrived', () => {
    const { container } = render(<LatencyHistogram buckets={[{ le: 1, count: 0 }]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
