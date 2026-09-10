import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Braces, Download, FileText, Package, Repeat, Table, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type { NatsMessage, StreamMessage } from 'shared';
import { type ExportFormat, exportMessages } from '../../lib/exportMessages';
import { Button } from '../ui/Button';
import { menuClass, menuItemClass as itemClass } from '../ui/misc';
import { useStore } from '../../store';
import { errorMessage } from '../../lib/api';
import { toast } from '../ui/Toast';
import ExportBundleDialog from '../bundle/ExportBundleDialog';
import ReplayDialog from './ReplayDialog';

/**
 * What an export is for decides its shape, so the menu offers the shapes
 * rather than one file that has to serve every purpose: an array to read, a
 * line per message to pipe, a column per field for a spreadsheet, the
 * payloads alone, and a script to put the traffic back on a bus.
 */
const FORMATS: { id: ExportFormat | null; label: string; hint: string; icon: ReactNode }[] = [
  {
    id: 'json',
    label: 'JSON',
    hint: 'One array of message objects, indented. For reading and for anything that loads a whole file.',
    icon: <Braces size={13} />,
  },
  {
    id: 'ndjson',
    label: 'NDJSON',
    hint: 'One message per line, the JSON payload as a document rather than a string. What jq, DuckDB (read_json_auto), ClickHouse and BigQuery read directly.',
    icon: <Braces size={13} />,
  },
  { id: null, label: 'sep-1', hint: '', icon: <span /> },
  { id: 'csv', label: 'CSV', hint: 'One row per message with the payload whole in one cell, plus the headers.', icon: <Table size={13} /> },
  {
    id: 'csv-flat',
    label: 'CSV, one column per field',
    hint: 'The JSON payload spread into payload.<field> columns and the headers into header.<name>. This is the one a spreadsheet, pandas or R can work with without unpacking anything first.',
    icon: <Table size={13} />,
  },
  { id: null, label: 'sep-2', hint: '', icon: <span /> },
  {
    id: 'payloads',
    label: 'Payloads only',
    hint: 'The message bodies and nothing else, one per line, to feed into another tool. A payload holding a newline spans lines -- use NDJSON when one record per line has to hold.',
    icon: <FileText size={13} />,
  },
  {
    id: 'sh',
    label: 'Replay script (.sh)',
    hint: 'A shell script that publishes the messages again with the nats CLI, headers included. Set DELAY to space them out.',
    icon: <Terminal size={13} />,
  },
];

/** Export the given messages as a file, or replay them. */
export default function ExportMenu({
  messages,
  name,
  size = 'sm',
  subject,
  loadAll,
  scope,
}: {
  messages: (NatsMessage | StreamMessage)[];
  name: string;
  size?: 'xs' | 'sm';
  /** offers a support bundle for this subject and everything below it */
  subject?: string;
  /**
   * Fetches everything the current selection covers, not only what is
   * loaded. Without it the export writes what the view holds -- which for a
   * time range is one page, and picking "30 d" and getting the first 2 000
   * messages is not what the range said.
   */
  loadAll?: () => Promise<(NatsMessage | StreamMessage)[]>;
  /** What the export covers, for the line above the formats ("the last 30 d"). */
  scope?: string;
}) {
  const [replay, setReplay] = useState(false);
  const [bundle, setBundle] = useState(false);
  const [busy, setBusy] = useState(false);
  const connId = useStore(s => s.activeConnId);
  const none = messages.length === 0;

  // The whole selection is gathered first, so the file holds what was asked
  // for rather than what happened to be scrolled into view.
  const run = async (format: ExportFormat) => {
    if (!loadAll) {
      exportMessages(messages, format, name);
      return;
    }
    setBusy(true);
    try {
      const all = await loadAll();
      exportMessages(all, format, name);
    } catch (err) {
      toast.error('Export failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button size={size} variant="outline" icon={<Download size={13} />} disabled={none} loading={busy} title="Export or replay these messages">
            Export
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className={menuClass}>
            {/* What lands in the file, before choosing how it is written. */}
            <div className="px-2 py-1 text-xs text-faint">
              {scope ? `Everything in ${scope}` : `${messages.length.toLocaleString('en-US')} loaded message${messages.length === 1 ? '' : 's'}`}
            </div>
            <DropdownMenu.Separator className="h-px bg-line my-1" />
            {FORMATS.map(f =>
              f.id === null ? (
                <DropdownMenu.Separator key={f.label} className="h-px bg-line my-1" />
              ) : (
                <DropdownMenu.Item key={f.id} className={itemClass} title={f.hint} onSelect={() => run(f.id as ExportFormat)}>
                  {f.icon} {f.label}
                </DropdownMenu.Item>
              ),
            )}
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
