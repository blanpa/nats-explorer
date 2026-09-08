// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubjectSchema } from '../../lib/api.schema';
import SchemaPanel from './SchemaPanel';

const getSchema = vi.fn();
vi.mock('../../lib/api.schema', () => ({ getSchema: (...a: unknown[]) => getSchema(...a) }));

const schema = (over: Partial<SubjectSchema> = {}): SubjectSchema => ({
  samples: 12,
  kinds: { json: 12 },
  fields: [
    { path: 'temp', types: [{ type: 'number', count: 12 }], presence: 1, example: '21.5', min: 19, max: 22 },
    { path: 'unit', types: [{ type: 'string', count: 6 }], presence: 0.5, example: '"C"', enum: ['C', 'F'] },
  ],
  drift: [],
  from: 1,
  to: 2,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  getSchema.mockResolvedValue({ subject: 'plant.temp', schema: schema() });
});
afterEach(() => {
  getSchema.mockReset();
});

describe('SchemaPanel', () => {
  it('stays collapsed until it is opened and then loads the schema', async () => {
    render(<SchemaPanel subject="plant.temp" connId="c1" />);
    expect(getSchema).not.toHaveBeenCalled();
    expect(screen.getByText('Fields, types and drift of this subject')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Schema/ }));
    expect(await screen.findByText('temp')).toBeInTheDocument();
    expect(getSchema).toHaveBeenCalledWith('plant.temp', { connId: 'c1', limit: 200 });
    // the optional field carries its presence, the numeric one its range
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('19 … 22')).toBeInTheDocument();
    expect(screen.getByText('C | F')).toBeInTheDocument();
    expect(screen.getByText(/from 12 messages/)).toBeInTheDocument();
  });

  it('marks drift in the header and next to the field', async () => {
    getSchema.mockResolvedValue({
      subject: 'plant.temp',
      schema: schema({ drift: [{ path: 'temp', kind: 'type-changed', before: 'number', after: 'string', since: 5 }] }),
    });
    localStorage.setItem('ne.schemaOpen', 'true');
    render(<SchemaPanel subject="plant.temp" />);
    expect(await screen.findByText('drift')).toBeInTheDocument();
    expect(screen.getByTitle('type changed from number to string')).toBeInTheDocument();
  });

  it('says so when the subject carries no JSON', async () => {
    getSchema.mockResolvedValue({ subject: 'raw', schema: schema({ fields: [], kinds: { binary: 4 } }) });
    localStorage.setItem('ne.schemaOpen', 'true');
    render(<SchemaPanel subject="raw" />);
    expect(await screen.findByText(/not JSON/)).toBeInTheDocument();
  });

  it('says so when nothing was recorded yet', async () => {
    getSchema.mockResolvedValue({ subject: 'quiet', schema: schema({ samples: 0, kinds: {}, fields: [] }) });
    localStorage.setItem('ne.schemaOpen', 'true');
    render(<SchemaPanel subject="quiet" />);
    expect(await screen.findByText(/No messages recorded/)).toBeInTheDocument();
  });
});
