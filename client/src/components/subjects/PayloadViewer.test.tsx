// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { encode } from '@msgpack/msgpack';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDecoders } from '../../lib/decoders';
import PayloadViewer from './PayloadViewer';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

beforeEach(() => {
  localStorage.clear();
  useDecoders.setState({ rules: [] });
});

describe('PayloadViewer', () => {
  it('renders JSON as a tree and offers the decoder button only with a subject', () => {
    const { rerender } = render(<PayloadViewer payload='{"temp":21}' type="json" />);
    expect(screen.getByText('"temp"')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Decode with a schema/ })).toBeNull();
    rerender(<PayloadViewer payload='{"temp":21}' type="json" subject="plant.temp" />);
    expect(screen.getByRole('button', { name: /Decode with a schema/ })).toBeInTheDocument();
  });

  it('decodes a binary payload with the matching rule', async () => {
    useDecoders.setState({ rules: [{ id: 'r', pattern: 'plant.>', format: 'msgpack' }] });
    render(<PayloadViewer payload={b64(encode({ temp: 21.5 }))} type="binary" subject="plant.temp" />);
    expect(await screen.findByText('"temp"')).toBeInTheDocument();
    expect(screen.getByText('21.5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit payload decoders' })).toBeInTheDocument();
  });

  it('explains a payload the rule cannot decode', async () => {
    useDecoders.setState({ rules: [{ id: 'r', pattern: 'plant.>', format: 'msgpack' }] });
    render(<PayloadViewer payload={b64(new Uint8Array([0xc1]))} type="binary" subject="plant.temp" />);
    expect(await screen.findByText(/Could not decode as msgpack/)).toBeInTheDocument();
  });
});
