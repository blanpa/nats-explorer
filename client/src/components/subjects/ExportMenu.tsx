import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Download, Package, Repeat } from 'lucide-react';
import { useState } from 'react';
import type { NatsMessage, StreamMessage } from 'shared';
import { exportMessages } from '../../lib/exportMessages';
import { Button } from '../ui/Button';
import { menuClass, menuItemClass as itemClass } from '../ui/misc';
import { useStore } from '../../store';
import ExportBundleDialog from '../bundle/ExportBundleDialog';
import ReplayDialog from './ReplayDialog';

/** Export the given messages as a file, or replay them. */
export default function ExportMenu({
  messages,
  name,
  size = 'sm',
  subject,
}: {
  messages: (NatsMessage | StreamMessage)[];
  name: string;
  size?: 'xs' | 'sm';
  /** offers a support bundle for this subject and everything below it */
  subject?: string;
}) {
  const [replay, setReplay] = useState(false);
  const [bundle, setBundle] = useState(false);
  const connId = useStore(s => s.activeConnId);
  const none = messages.length === 0;
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button size={size} variant="outline" icon={<Download size={13} />} disabled={none} title="Export or replay these messages">
            Export
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className={menuClass}>
            <DropdownMenu.Item className={itemClass} onSelect={() => exportMessages(messages, 'json', name)}>
              <Download size={13} /> JSON ({messages.length.toLocaleString('en-US')})
            </DropdownMenu.Item>
            <DropdownMenu.Item className={itemClass} onSelect={() => exportMessages(messages, 'csv', name)}>
              <Download size={13} /> CSV
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="h-px bg-line my-1" />
            <DropdownMenu.Item className={itemClass} onSelect={() => setReplay(true)}>
              <Repeat size={13} /> Replay…
            </DropdownMenu.Item>
            {subject && connId && (
              <DropdownMenu.Item className={itemClass} onSelect={() => setBundle(true)}>
                <Package size={13} /> Support bundle…
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {replay && <ReplayDialog messages={messages} name={name} onClose={() => setReplay(false)} />}
      {bundle && connId && <ExportBundleDialog connId={connId} subject={subject} onClose={() => setBundle(false)} />}
    </>
  );
}
