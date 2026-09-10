// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../lib/auth';
import { useStore } from '../../store';
import { ConfirmHost } from '../ui/Dialog';
import SubjectTree from './SubjectTree';

/**
 * The eraser in the tree header used to clear everything without saying so,
 * whatever was selected. Clearing one branch and watching an unrelated one
 * disappear with it is the bug this covers.
 */

const clearHistory = vi.fn(async () => undefined);
const clearSubject = vi.fn(async (_subject: string, _branch: boolean) => 3);
vi.mock('../../lib/feed', () => ({
  clearHistory: () => clearHistory(),
  clearSubject: (subject: string, branch: boolean) => clearSubject(subject, branch),
  loadHistory: vi.fn(async () => undefined),
}));
vi.mock('../../lib/api', () => ({ api: {}, errorMessage: (e: unknown) => String(e) }));

function open() {
  render(
    <>
      <SubjectTree />
      <ConfirmHost />
    </>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Clear message history' }));
}

beforeEach(() => {
  localStorage.clear();
  useAuth.setState({ mode: 'none', role: 'admin' });
  useStore.setState({ selectedSubject: 'uns', selectedSubjects: ['uns'], connections: [] });
});
afterEach(() => {
  clearHistory.mockClear();
  clearSubject.mockClear();
});

describe('the eraser in the tree header', () => {
  it('offers the selected subject before everything, and clears only it', async () => {
    open();
    expect(await screen.findByText('Clear message history')).toBeInTheDocument();
    // The narrow scope is the one the dialog opens on.
    const narrow = screen.getByRole('button', { name: 'Only the selected subject' });
    expect(narrow).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Everything' })).toBeInTheDocument();

    fireEvent.click(narrow);
    await waitFor(() => expect(clearSubject).toHaveBeenCalledWith('uns', true));
    expect(clearHistory).not.toHaveBeenCalled();
  });

  it('still clears everything when that is what was asked for', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Everything' }));
    await waitFor(() => expect(clearHistory).toHaveBeenCalled());
    expect(clearSubject).not.toHaveBeenCalled();
  });

  it('asks a plain question when nothing is selected', async () => {
    useStore.setState({ selectedSubject: null, selectedSubjects: [] });
    open();
    expect(await screen.findByRole('button', { name: 'Clear everything' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Only the selected subject' })).not.toBeInTheDocument();
    // Closed again: an open modal marks the rest of the page aria-hidden,
    // and the next test would not find the button it opens from.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('does nothing when the dialog is dismissed', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Clear message history')).not.toBeInTheDocument());
    expect(clearHistory).not.toHaveBeenCalled();
    expect(clearSubject).not.toHaveBeenCalled();
  });
});
