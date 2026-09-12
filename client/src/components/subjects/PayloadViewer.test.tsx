// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { encode } from '@msgpack/msgpack';
import protobuf from 'protobufjs';
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

  it('offers an XML payload as XML, indented rather than rendered', () => {
    render(<PayloadViewer payload="<reading><celsius>21.5</celsius></reading>" type="string" />);
    fireEvent.click(screen.getByRole('button', { name: 'XML' }));
    // Indented source, and still source: the tags are text, not elements.
    expect(screen.getByText(/<celsius>21.5<\/celsius>/)).toBeInTheDocument();
    expect(document.querySelector('celsius')).toBeNull();
  });

  it('calls an HTML payload HTML, and JSON neither', () => {
    const { rerender } = render(<PayloadViewer payload="<div><p>hi</p></div>" type="string" />);
    expect(screen.getByRole('button', { name: 'HTML' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'XML' })).toBeNull();
    rerender(<PayloadViewer payload='{"a":1}' type="json" />);
    expect(screen.queryByRole('button', { name: 'HTML' })).toBeNull();
  });

  it('shows the bytes as base64 for anything', () => {
    render(<PayloadViewer payload="hi" type="string" />);
    fireEvent.click(screen.getByRole('button', { name: 'Base64' }));
    expect(screen.getByText('aGk=')).toBeInTheDocument();
  });

  it('reads a protobuf payload by field number when no schema is at hand', () => {
    const { root } = protobuf.parse('syntax = "proto3"; message R { string id = 1; int32 n = 2; }', { keepCase: true });
    const R = root.lookupType('R');
    render(<PayloadViewer payload={b64(R.encode(R.fromObject({ id: 'lobby-1', n: 94 })).finish())} type="binary" subject="plant.temp" />);
    fireEvent.click(screen.getByRole('button', { name: 'Fields' }));
    expect(screen.getByText('"1"')).toBeInTheDocument();
    expect(screen.getByText('"lobby-1"')).toBeInTheDocument();
    expect(screen.getByText('94')).toBeInTheDocument();
    expect(screen.getByText(/No schema: these are the 2 fields/)).toBeInTheDocument();
  });

  it('offers no field view for bytes that are not a protobuf message', () => {
    render(<PayloadViewer payload={b64(new Uint8Array([0xff, 0xff, 0xff]))} type="binary" subject="plant.temp" />);
    expect(screen.queryByRole('button', { name: 'Fields' })).toBeNull();
  });

  it('explains a payload the rule cannot decode', async () => {
    useDecoders.setState({ rules: [{ id: 'r', pattern: 'plant.>', format: 'msgpack' }] });
    render(<PayloadViewer payload={b64(new Uint8Array([0xc1]))} type="binary" subject="plant.temp" />);
    expect(await screen.findByText(/Could not decode as msgpack/)).toBeInTheDocument();
  });
});
