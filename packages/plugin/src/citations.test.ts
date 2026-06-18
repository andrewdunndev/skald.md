/**
 * Unit tests for citations.ts — pure helpers.
 * Chat-session integration tests live in citations.session.test.ts.
 *
 * Covers:
 *   1. buildDocumentBlock shape (no cache_control — Fix 4)
 *   2. parseCitationLocation — all three types + malformed inputs
 *   3. citationLabel — 1-indexed display
 *   4. citationPath — known and unknown indices
 * (The providerCapabilities.citations gate is covered in
 *  provider-capabilities.test.ts.)
 */

import { describe, expect, it } from 'vitest';
import {
  buildDocumentBlock,
  parseCitationLocation,
  citationLabel,
  citationPath,
} from './citations';

// The citations capability gate (anthropic=true / openrouter=false) is
// covered in provider-capabilities.test.ts — not restated here.

// ── buildDocumentBlock ────────────────────────────────────────────────────────

describe('buildDocumentBlock', () => {
  it('produces a document block with the correct shape', () => {
    const block = buildDocumentBlock('notes/foo.md', 'The grass is green.');
    expect(block.type).toBe('document');
    expect(block.title).toBe('notes/foo.md');
    expect(block.citations).toEqual({ enabled: true });
    expect(block.source.type).toBe('text');
    expect(block.source.media_type).toBe('text/plain');
    expect(block.source.data).toBe('The grass is green.');
  });

  it('never emits cache_control (Fix 4: capability removed)', () => {
    // Document blocks are per-request grounding, not cross-turn cache
    // candidates. A cache_control here risks a 4th+ breakpoint → 400.
    const block = buildDocumentBlock('a.md', 'body') as unknown as Record<string, unknown>;
    expect('cache_control' in block).toBe(false);
    expect(block.cache_control).toBeUndefined();
  });
});

// ── parseCitationLocation ─────────────────────────────────────────────────────

describe('parseCitationLocation', () => {
  it('parses a char_location citation', () => {
    const raw = {
      type: 'char_location',
      cited_text: 'The grass is green.',
      document_index: 0,
      document_title: 'My Doc',
      start_char_index: 0,
      end_char_index: 19,
    };
    const parsed = parseCitationLocation(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe('char_location');
    expect(parsed?.document_index).toBe(0);
    expect(parsed?.cited_text).toBe('The grass is green.');
  });

  it('parses a page_location citation', () => {
    const raw = {
      type: 'page_location',
      cited_text: 'Some text',
      document_index: 1,
      document_title: 'PDF',
      start_page_number: 3,
      end_page_number: 4,
    };
    expect(parseCitationLocation(raw)?.type).toBe('page_location');
  });

  it('parses a content_block_location citation', () => {
    const raw = {
      type: 'content_block_location',
      cited_text: 'chunk text',
      document_index: 2,
      document_title: null,
      start_block_index: 0,
      end_block_index: 1,
    };
    expect(parseCitationLocation(raw)?.type).toBe('content_block_location');
  });

  it('returns null for unknown type', () => {
    expect(parseCitationLocation({ type: 'unknown_location' })).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseCitationLocation(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseCitationLocation('string')).toBeNull();
    expect(parseCitationLocation(42)).toBeNull();
  });
});

// ── citationLabel ─────────────────────────────────────────────────────────────

describe('citationLabel', () => {
  it('returns [1] for document_index 0 (1-indexed display)', () => {
    expect(citationLabel(0)).toBe('[1]');
  });

  it('returns [3] for document_index 2', () => {
    expect(citationLabel(2)).toBe('[3]');
  });
});

// ── citationPath ──────────────────────────────────────────────────────────────

describe('citationPath', () => {
  it('returns the path for a known document index', () => {
    const registry = new Map([[0, 'notes/foo.md'], [1, 'notes/bar.md']]);
    const citation = {
      type: 'char_location' as const,
      cited_text: 'x',
      document_index: 1,
      document_title: 'bar',
    };
    expect(citationPath(registry, citation)).toBe('notes/bar.md');
  });

  it('returns null for an unknown document index', () => {
    const registry = new Map<number, string>();
    const citation = {
      type: 'char_location' as const,
      cited_text: 'x',
      document_index: 5,
      document_title: null,
    };
    expect(citationPath(registry, citation)).toBeNull();
  });
});
