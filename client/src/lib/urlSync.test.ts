// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from 'shared';
import { useStore } from '../store';
import { useSavedConnections } from '../store/savedConnections';
import { installUrlSync } from './urlSync';

const conn = (id: string, connected = true): ConnectionStatus => ({ id, name: id, connected, reconnecting: false, color: '#000', reconnects: 0 });

let stop: (() => void) | null = null;

beforeEach(() => {
  history.replaceState(null, '', '/');
  useStore.setState({
    module: 'subjects',
    connections: [],
    connectionsLoaded: false,
    activeConnId: null,
    selectedSubject: null,
    selectedSubjects: [],
    range: null,
    selectedStream: null,
    selectedKvBucket: null,
    selectedKvKey: null,
    expanded: new Set(),
    expandAll: false,
  });
  useSavedConnections.setState({ items: [], connecting: new Set() });
});

afterEach(() => {
  stop?.();
  stop = null;
});

describe('installUrlSync', () => {
  it('writes the view into the hash', () => {
    useStore.setState({ connections: [conn('c1')], connectionsLoaded: true, activeConnId: 'c1' });
    stop = installUrlSync();
    useStore.getState().setSelectedSubject('plant.oven.temp');
    expect(location.hash).toBe('#/subjects?conn=c1&subject=plant.oven.temp');
    useStore.getState().setModule('jetstream');
    useStore.getState().setSelectedStream('ORDERS');
    expect(location.hash).toBe('#/jetstream?conn=c1&stream=ORDERS');
  });

  it('applies a link once the connection list is in', () => {
    history.replaceState(null, '', '/#/kv?conn=c1&bucket=config&key=line1');
    stop = installUrlSync();
    // Nothing is known yet: the hash stays as it was, so a reload keeps the link.
    expect(useStore.getState().module).toBe('subjects');
    expect(location.hash).toBe('#/kv?conn=c1&bucket=config&key=line1');
    useStore.getState().setConnections([conn('c1')]);
    const s = useStore.getState();
    expect(s.module).toBe('kv');
    expect(s.activeConnId).toBe('c1');
    expect(s.selectedKvBucket).toBe('config');
    expect(s.selectedKvKey).toBe('line1');
  });

  it('opens the subject with its window and the branches above it', () => {
    history.replaceState(null, '', '/#/subjects?conn=c1&subject=plant.oven.temp&from=1000&to=2000');
    stop = installUrlSync();
    useStore.getState().setConnections([conn('c1')]);
    const s = useStore.getState();
    expect(s.selectedSubject).toBe('plant.oven.temp');
    expect([...s.expanded].sort()).toEqual(['plant', 'plant.oven']);
    expect(s.range).toMatchObject({ from: 1000, to: 2000 });
  });

  it('a link without a connection is applied at once', () => {
    history.replaceState(null, '', '/#/alerts');
    stop = installUrlSync();
    expect(useStore.getState().module).toBe('alerts');
  });

  it('opens a saved connection the link names', async () => {
    const connect = vi.fn(async (id: string) => {
      useStore.getState().setConnections([conn(id)]);
      useStore.getState().setActiveConnId(id);
      return true;
    });
    useSavedConnections.setState({
      items: [{ id: 'saved1', name: 'Plant', servers: ['nats://x'], authMethod: 'none', subscriptions: ['>'], sysTopics: {} }],
      connect,
    });
    history.replaceState(null, '', '/#/jetstream?conn=saved1&stream=ORDERS');
    stop = installUrlSync();
    useStore.getState().setConnections([]);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledWith('saved1'));
    await vi.waitFor(() => expect(useStore.getState().selectedStream).toBe('ORDERS'));
    expect(useStore.getState().module).toBe('jetstream');
  });

  it('the back button walks back to the previous subject', () => {
    useStore.setState({ connections: [conn('c1')], connectionsLoaded: true, activeConnId: 'c1' });
    stop = installUrlSync();
    useStore.getState().setSelectedSubject('a.one');
    useStore.getState().setSelectedSubject('a.two');
    history.replaceState(null, '', '/#/subjects?conn=c1&subject=a.one');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(useStore.getState().selectedSubject).toBe('a.one');
  });
});
