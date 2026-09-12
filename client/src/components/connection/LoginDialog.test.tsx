// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../lib/auth';
import LoginDialog from './LoginDialog';

vi.mock('../../lib/ws', () => ({ wsClient: { reset: vi.fn(), disconnect: vi.fn() } }));

const initial = useAuth.getState();

afterEach(() => {
  useAuth.setState(initial, true);
  vi.restoreAllMocks();
});

describe('LoginDialog', () => {
  it('stays hidden while no login is required', () => {
    render(<LoginDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for a token in token mode', () => {
    useAuth.setState({ mode: 'token', required: true, authenticated: false });
    render(<LoginDialog />);
    expect(screen.getByRole('dialog', { name: 'API token required' })).toBeInTheDocument();
    expect(screen.queryByLabelText('User')).toBeNull();
    expect(screen.getByLabelText('Token')).toBeInTheDocument();
  });

  it('signs a user in and closes on success', async () => {
    useAuth.setState({ mode: 'users', required: true, authenticated: false });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ user: 'alice', role: 'admin' }), { status: 200 }));
    render(<LoginDialog />);
    fireEvent.change(screen.getByLabelText('User'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/login',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ user: 'alice', password: 'secret' }) }),
    );
    expect(useAuth.getState()).toMatchObject({ authenticated: true, user: 'alice', role: 'admin', required: false });
  });

  it('shows the backend error on a wrong password', async () => {
    useAuth.setState({ mode: 'users', required: true, authenticated: false });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'wrong credentials' }), { status: 401 }));
    render(<LoginDialog />);
    fireEvent.change(screen.getByLabelText('User'), { target: { value: 'bob' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('wrong credentials');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
