// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appInfo } from '../../lib/storage';
import { SourceLink } from './SourceLink';

const initial = { ...appInfo };

afterEach(() => {
  Object.assign(appInfo, initial);
  delete appInfo.commit;
  delete appInfo.source;
  delete (window as Window).runtime;
});

describe('SourceLink', () => {
  it('links the source the backend resolved for this build', () => {
    Object.assign(appInfo, { version: '0.3.0', commit: 'abc1234', source: 'https://github.com/blanpa/nats-explorer/tree/abc1234' });
    render(<SourceLink />);
    const link = screen.getByRole('link');
    expect(link).toHaveTextContent('v0.3.0 · source');
    expect(link).toHaveAttribute('href', 'https://github.com/blanpa/nats-explorer/tree/abc1234');
    expect(link.getAttribute('title')).toContain('AGPL');
  });

  it('follows a deployment that points elsewhere', () => {
    Object.assign(appInfo, { version: '0.3.0', source: 'https://git.example.org/ops/explorer' });
    render(<SourceLink />);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://git.example.org/ops/explorer');
  });

  it('stays a link when the backend said nothing', () => {
    Object.assign(appInfo, { version: 'dev' });
    render(<SourceLink />);
    const link = screen.getByRole('link');
    expect(link).toHaveTextContent('dev · source');
    expect(link.getAttribute('href')).toContain('github.com');
  });

  it('opens the system browser in the desktop app instead of navigating the webview', () => {
    const BrowserOpenURL = vi.fn();
    Object.assign(appInfo, { mode: 'desktop', version: '0.3.0', source: 'https://example.org/src' });
    (window as Window).runtime = { BrowserOpenURL };
    render(<SourceLink />);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(screen.getByRole('link'), click);
    expect(BrowserOpenURL).toHaveBeenCalledWith('https://example.org/src');
    expect(click.defaultPrevented).toBe(true);
  });
});
