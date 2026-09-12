import type { MouseEvent } from 'react';
import { appInfo } from '../../lib/storage';
import { cn } from '../../lib/utils';

/**
 * The offer of source that the AGPL asks for: whoever reaches this UI over a
 * network can get the source of the build that serves it. The backend resolves
 * the target (`SOURCE_URL`, else this project at the commit or tag it was built
 * from), so a modified deployment points here at its own repository without a
 * change in the frontend.
 */
export function SourceLink({ className, showLicense }: { className?: string; showLicense?: boolean }) {
  const label = !appInfo.version || appInfo.version === 'dev' ? 'dev' : `v${appInfo.version}`;
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    // The desktop webview would navigate away from the app; Wails opens the
    // system browser instead. In a normal browser target=_blank does it.
    const browserOpen = window.runtime?.BrowserOpenURL;
    if (appInfo.mode === 'desktop' && browserOpen) {
      e.preventDefault();
      browserOpen(e.currentTarget.href);
    }
  };
  return (
    <a
      href={appInfo.source ?? 'https://github.com/blanpa/nats-explorer'}
      target="_blank"
      rel="noreferrer"
      onClick={open}
      className={cn('font-mono text-faint hover:text-fg hover:underline', className)}
      title={`NATS Explorer ${label}${appInfo.commit ? ` (${appInfo.commit})` : ''} -- free software under the GNU AGPL v3.0 or later. Opens the source of this build.`}
    >
      {label} · {showLicense ? 'AGPL source' : 'source'}
    </a>
  );
}
