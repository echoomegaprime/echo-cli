import { describe, it, expect } from 'vitest';
import { formatOutput } from '../src/formatters.js';

describe('formatOutput', () => {
  it('json format produces pretty-printed JSON', () => {
    const out = formatOutput({ a: 1, b: 'two' }, 'json');
    expect(JSON.parse(out)).toEqual({ a: 1, b: 'two' });
    expect(out).toContain('\n');
  });

  it('text format renders a plain string as-is', () => {
    expect(formatOutput('hello', 'text')).toBe('hello');
  });

  it('text format renders an array of objects with an index label', () => {
    const out = formatOutput([{ name: 'a' }, { name: 'b' }], 'text');
    expect(out).toContain('[1]');
    expect(out).toContain('[2]');
    expect(out).toContain('name');
  });

  it('table format renders an array of objects as a bordered table', () => {
    const out = formatOutput([{ id: 1, name: 'foo' }], 'table');
    expect(out).toContain('id');
    expect(out).toContain('name');
    expect(out).toContain('foo');
  });
});
