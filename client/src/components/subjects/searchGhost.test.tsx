// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SearchInput } from '../ui/Input';
import { completionFor } from './completeFilter';

const subjects = ['uns.acme.robot-01.position', 'uns.acme.robot-02.position', 'uns.acme.conveyor.speed'];

/** The field as the tree wires it: typed text in, completion offered back. */
function Filter() {
  const [value, setValue] = useState('');
  const suggestion = completionFor(value, subjects);
  return (
    <>
      <SearchInput
        value={value}
        onChange={e => setValue(e.target.value)}
        suggestion={suggestion}
        onAcceptSuggestion={() => setValue(value + suggestion)}
        aria-label="Filter subjects"
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

const field = () => screen.getByLabelText('Filter subjects') as HTMLInputElement;
const value = () => screen.getByTestId('value').textContent;

describe('the filter box completing itself', () => {
  it('offers what the typed term could grow into', () => {
    render(<Filter />);
    fireEvent.change(field(), { target: { value: 'rob' } });
    // robot-01 and robot-02 share robot-0.
    expect(screen.getByText('ot-0')).toBeInTheDocument();
  });

  it('takes the offer on Tab, adding to the end', () => {
    render(<Filter />);
    fireEvent.change(field(), { target: { value: 'rob' } });
    field().setSelectionRange(3, 3);
    fireEvent.keyDown(field(), { key: 'Tab' });
    expect(value()).toBe('robot-0');
  });

  it('takes it on the right arrow too', () => {
    render(<Filter />);
    fireEvent.change(field(), { target: { value: 'convey' } });
    field().setSelectionRange(6, 6);
    fireEvent.keyDown(field(), { key: 'ArrowRight' });
    expect(value()).toBe('conveyor');
  });

  it('leaves the arrow alone when the cursor is not at the end', () => {
    render(<Filter />);
    fireEvent.change(field(), { target: { value: 'rob' } });
    field().setSelectionRange(1, 1);
    fireEvent.keyDown(field(), { key: 'ArrowRight' });
    // Moving through the text is what the arrow is for there.
    expect(value()).toBe('rob');
  });

  it('offers nothing to complete when there is nothing to add', () => {
    render(<Filter />);
    fireEvent.change(field(), { target: { value: 'zzz' } });
    expect(screen.queryByText(/./, { selector: '.text-faint' })).toBeNull();
    fireEvent.keyDown(field(), { key: 'Tab' });
    expect(value()).toBe('zzz');
  });

  it('still clears on Escape', () => {
    render(<Filter />);
    fireEvent.change(field(), { target: { value: 'rob' } });
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(value()).toBe('');
  });
});
