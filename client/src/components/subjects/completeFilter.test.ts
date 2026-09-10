import { describe, expect, it } from 'vitest';
import { candidatesFor, completionFor } from './completeFilter';

const subjects = [
  'uns.acme.factory-berlin.assembly.line-1.robot-01.position',
  'uns.acme.factory-berlin.assembly.line-1.robot-01.status',
  'uns.acme.factory-berlin.assembly.line-1.robot-02.position',
  'uns.acme.factory-berlin.logistics.warehouse.agv-01.state',
  'metrics.oee.line-1',
];

describe('completionFor', () => {
  it('grows a segment to what its candidates share', () => {
    // robot-01 and robot-02: the shared start is robot-0.
    expect(completionFor('rob', subjects)).toBe('ot-0');
    expect(completionFor('robot-0', subjects)).toBe('');
  });

  it('completes a segment fully when only one matches', () => {
    expect(completionFor('warehou', subjects)).toBe('se');
    expect(completionFor('logi', subjects)).toBe('stics');
  });

  it('grows a dotted term one segment at a time', () => {
    // Not all the way to the leaf: a long subject arrives in steps.
    expect(completionFor('uns.', subjects)).toBe('acme.');
    expect(completionFor('uns.acme.', subjects)).toBe('factory-berlin.');
    expect(completionFor('uns.acme.factory-berlin.', subjects)).toBe('');
  });

  it('completes only the term being written', () => {
    // The first term is settled; the second is the one under the cursor.
    expect(completionFor('line-1 rob', subjects)).toBe('ot-0');
    // A trailing space means the reader has moved on.
    expect(completionFor('rob ', subjects)).toBe('');
  });

  it('says nothing when there is nothing to add', () => {
    expect(completionFor('', subjects)).toBe('');
    expect(completionFor('zzz', subjects)).toBe('');
    expect(completionFor('position', subjects)).toBe('');
  });

  it('ignores case while keeping the case of the candidate', () => {
    expect(completionFor('WAREHOU', subjects)).toBe('se');
    expect(completionFor('Uns.', subjects)).toBe('acme.');
  });

  it('never rewrites what was typed', () => {
    // A term that only occurs inside a segment has no completion: growing
    // it would mean replacing the letters already on screen.
    expect(completionFor('bot', subjects)).toBe('');
  });
});

describe('candidatesFor', () => {
  it('collects the segments a bare term could become', () => {
    expect(candidatesFor('robot', subjects).sort()).toEqual(['robot-01', 'robot-02']);
  });

  it('collects one further segment for a dotted term', () => {
    expect(candidatesFor('uns.acme.factory-berlin.', subjects).sort()).toEqual(['uns.acme.factory-berlin.assembly.', 'uns.acme.factory-berlin.logistics.']);
  });

  it('keeps the last segment whole when nothing follows it', () => {
    expect(candidatesFor('metrics.oee.', subjects)).toEqual(['metrics.oee.line-1']);
  });
});
