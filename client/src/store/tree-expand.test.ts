// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './index';

/**
 * A filter shows every match, so the ordinary expansion set says nothing
 * about that view. Toggling under a filter therefore has to keep its own
 * exceptions -- and must not disturb what the reader had open before.
 */
beforeEach(() => {
  useStore.setState({ subjectFilter: '', expandAll: false, expanded: new Set(), filterCollapsed: new Set(), treeRows: [] });
});

describe('expanding under a filter', () => {
  it('reports everything expanded while a filter is on', () => {
    const s = useStore.getState();
    expect(s.isExpanded('uns.robot')).toBe(false);
    useStore.getState().setSubjectFilter('robot');
    expect(useStore.getState().isExpanded('uns.robot')).toBe(true);
  });

  it('closes a branch and keeps it closed', () => {
    useStore.getState().setSubjectFilter('robot');
    useStore.getState().toggleExpanded('uns.robot');
    expect(useStore.getState().isExpanded('uns.robot')).toBe(false);
    // Everything else stays open.
    expect(useStore.getState().isExpanded('uns')).toBe(true);
    useStore.getState().toggleExpanded('uns.robot');
    expect(useStore.getState().isExpanded('uns.robot')).toBe(true);
  });

  it('leaves the unfiltered expansion alone', () => {
    useStore.setState({ expanded: new Set(['uns']) });
    useStore.getState().setSubjectFilter('robot');
    useStore.getState().toggleExpanded('uns.robot');
    useStore.getState().setSubjectFilter('');
    // Back to the tree as it was: `uns` open, nothing else touched.
    expect([...useStore.getState().expanded]).toEqual(['uns']);
    expect(useStore.getState().isExpanded('uns')).toBe(true);
    expect(useStore.getState().isExpanded('uns.robot')).toBe(false);
  });

  it('forgets what was closed when the filter changes', () => {
    useStore.getState().setSubjectFilter('robot');
    useStore.getState().toggleExpanded('uns.robot');
    useStore.getState().setSubjectFilter('robo');
    // A new filter is a new set of matches; the old exceptions mean nothing.
    expect(useStore.getState().isExpanded('uns.robot')).toBe(true);
  });

  it('collapses what is on screen when asked to collapse all under a filter', () => {
    useStore.setState({
      subjectFilter: 'robot',
      treeRows: [
        { subject: 'uns', hasChildren: true },
        { subject: 'uns.robot', hasChildren: true },
        { subject: 'uns.robot.position', hasChildren: false },
      ] as never,
    });
    useStore.getState().collapseAll();
    expect(useStore.getState().isExpanded('uns')).toBe(false);
    expect(useStore.getState().isExpanded('uns.robot')).toBe(false);
    // Expanding all again clears the exceptions rather than turning on the
    // unfiltered "everything open" mode.
    useStore.getState().expandAllBranches();
    expect(useStore.getState().expandAll).toBe(false);
    expect(useStore.getState().isExpanded('uns.robot')).toBe(true);
  });
});
