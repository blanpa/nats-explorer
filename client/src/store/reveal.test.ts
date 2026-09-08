// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './index';

beforeEach(() => {
  useStore.setState({ expandAll: false, expanded: new Set(), selectedSubject: null, selectedSubjects: [] });
});

describe('revealSubject', () => {
  it('opens every branch above the subject and selects it', () => {
    useStore.getState().revealSubject('plant.line1.oven.temp');
    const { expanded, selectedSubject } = useStore.getState();
    expect([...expanded].sort()).toEqual(['plant', 'plant.line1', 'plant.line1.oven']);
    expect(selectedSubject).toBe('plant.line1.oven.temp');
  });

  it('keeps branches that were already open', () => {
    useStore.setState({ expanded: new Set(['other', 'other.branch']) });
    useStore.getState().revealSubject('plant.line1');
    expect([...useStore.getState().expanded].sort()).toEqual(['other', 'other.branch', 'plant']);
  });

  it('a root subject needs no branch opened', () => {
    useStore.getState().revealSubject('orders');
    expect([...useStore.getState().expanded]).toEqual([]);
    expect(useStore.getState().selectedSubject).toBe('orders');
  });

  it('with everything expanded it removes the ancestors from the collapsed set', () => {
    // In that mode the set holds the exceptions, so revealing means uncollapsing.
    useStore.setState({ expandAll: true, expanded: new Set(['plant', 'plant.line1', 'elsewhere']) });
    useStore.getState().revealSubject('plant.line1.oven');
    expect([...useStore.getState().expanded]).toEqual(['elsewhere']);
  });
});
