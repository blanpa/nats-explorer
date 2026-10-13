// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../store';
import { BesidePane, useSelectedKvBucket, useSelectedKvKey } from './pane';

let setBucket: (b: string | null) => void = () => {};
let setKey: (k: string | null) => void = () => {};

function Probe() {
  const [bucket, sb] = useSelectedKvBucket();
  const [key, sk] = useSelectedKvKey();
  setBucket = sb;
  setKey = sk;
  return <span data-testid="sel">{`${bucket ?? '-'}/${key ?? '-'}`}</span>;
}

beforeEach(() => {
  useStore.setState({ selectedKvBucket: 'main', selectedKvKey: 'k1', beside: { module: 'kv', name: 'other' } });
});

describe('pane selection', () => {
  it('follows the store in the main pane', () => {
    render(<Probe />);
    expect(screen.getByTestId('sel').textContent).toBe('main/k1');
  });

  it('keeps its own bucket and key beside, and leaves the store alone', () => {
    render(
      <BesidePane module="kv" name="other">
        <Probe />
      </BesidePane>,
    );
    expect(screen.getByTestId('sel').textContent).toBe('other/-');
    act(() => setKey('k2'));
    expect(screen.getByTestId('sel').textContent).toBe('other/k2');
    expect(useStore.getState().selectedKvKey).toBe('k1');
  });

  it('closes when its bucket goes', () => {
    render(
      <BesidePane module="kv" name="other">
        <Probe />
      </BesidePane>,
    );
    act(() => setBucket(null));
    expect(useStore.getState().beside).toBeNull();
  });
});
