import { describe, expect, it } from 'vitest';
import { parseStartersNote } from './empty-state';

describe('parseStartersNote', () => {
  it('parses a single starter with em-dash + icon', () => {
    const out = parseStartersNote(
      '- :list-checks: What is loose — Scan my vault for unresolved items.',
    );
    expect(out).toEqual([
      {
        icon: 'list-checks',
        label: 'What is loose',
        prompt: 'Scan my vault for unresolved items.',
      },
    ]);
  });

  it('parses a starter without an icon', () => {
    const out = parseStartersNote(
      '- Ask a question — Just open the chat without a preset.',
    );
    expect(out).toEqual([
      {
        icon: null,
        label: 'Ask a question',
        prompt: 'Just open the chat without a preset.',
      },
    ]);
  });

  it('accepts " -- " as a label/prompt separator', () => {
    const out = parseStartersNote('- Brief me -- Brief me on today.');
    expect(out[0]).toEqual({
      icon: null,
      label: 'Brief me',
      prompt: 'Brief me on today.',
    });
  });

  it('accepts " - " as a label/prompt separator', () => {
    const out = parseStartersNote('- Brief me - Brief me on today.');
    expect(out[0]).toEqual({
      icon: null,
      label: 'Brief me',
      prompt: 'Brief me on today.',
    });
  });

  it('parses multiple starters across lines', () => {
    const body = [
      '- :camera: Identify + file — Identify and route this image.',
      '- :brain: Remember — Add this fact via remember_fact.',
      '- Open chat — ',
    ].join('\n');
    const out = parseStartersNote(body);
    // Third entry has empty prompt half, so it's skipped.
    expect(out).toHaveLength(2);
    expect(out[0].icon).toBe('camera');
    expect(out[1].icon).toBe('brain');
  });

  it('skips lines that are not list items', () => {
    const body = [
      '# Heading',
      'A paragraph that mentions a - dash.',
      '- :search: Find — Find related notes.',
    ].join('\n');
    const out = parseStartersNote(body);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Find');
  });

  it('strips YAML frontmatter before parsing', () => {
    const body = [
      '---',
      'description: my starters',
      '---',
      '- :brain: Remember — Add this to memory.',
    ].join('\n');
    const out = parseStartersNote(body);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Remember');
  });

  it('returns an empty array for an empty body', () => {
    expect(parseStartersNote('')).toEqual([]);
  });

  it('returns an empty array when no list items present', () => {
    expect(parseStartersNote('Just some prose.\n\nWith a paragraph.')).toEqual(
      [],
    );
  });

  it('rejects an item with a label but no prompt half', () => {
    expect(parseStartersNote('- :brain: Remember')).toEqual([]);
  });

  it('rejects an item with an icon and prompt but no label', () => {
    const out = parseStartersNote('- :brain: — Just the icon, no label.');
    expect(out).toEqual([]);
  });
});
