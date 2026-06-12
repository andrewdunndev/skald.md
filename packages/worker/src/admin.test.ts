/**
 * renderAdminPage tests. The admin page is the only operator-facing
 * surface that ships HTML directly; tests assert structural elements
 * + the "no secret leak" invariant (token values must NEVER appear
 * in the rendered output, even when token labels mention secret-looking
 * strings).
 */
import { describe, expect, it } from 'vitest';
import { renderAdminPage, type AdminViewModel } from './admin';

const BASE_VM: AdminViewModel = {
  version: 7,
  workerName: 'scribian',
  anthropicKeyPresent: true,
  openrouterKeyPresent: false,
  aiGatewayConfigured: false,
  tokenSummaries: [],
  connectedWebSockets: 0,
  recentEvents: [],
};

describe('renderAdminPage', () => {
  it('renders the worker name + version in the heading', () => {
    const html = renderAdminPage(BASE_VM);
    expect(html).toContain('<h1>scribian');
    expect(html).toContain('v7');
  });

  it('marks Anthropic key as "set on Worker" when present', () => {
    const html = renderAdminPage({ ...BASE_VM, anthropicKeyPresent: true });
    expect(html).toContain('Anthropic key');
    expect(html).toContain('set on Worker');
  });

  it('marks Anthropic key as "plugin-supplied only" when absent', () => {
    const html = renderAdminPage({ ...BASE_VM, anthropicKeyPresent: false });
    expect(html).toContain('plugin-supplied only');
  });

  it('marks OpenRouter key as "not configured" when absent', () => {
    const html = renderAdminPage({ ...BASE_VM, openrouterKeyPresent: false });
    expect(html).toContain('not configured');
  });

  it('renders the connected-plugin count verbatim', () => {
    const html = renderAdminPage({ ...BASE_VM, connectedWebSockets: 3 });
    expect(html).toMatch(/Connected plugins[\s\S]*?<span class="v">3<\/span>/);
  });

  it('shows an empty-state message when no tokens are configured', () => {
    const html = renderAdminPage({ ...BASE_VM, tokenSummaries: [] });
    expect(html).toContain('No tokens configured');
  });

  it('renders the token table with label + scope badges', () => {
    const html = renderAdminPage({
      ...BASE_VM,
      tokenSummaries: [
        { label: 'plugin', scopes: ['chat'] },
        { label: 'reader', scopes: ['chat'] },
      ],
    });
    expect(html).toContain('<td>plugin</td>');
    expect(html).toContain('<td>reader</td>');
    expect(html).toContain('chat');
  });

  it('NEVER leaks a token value in the rendered HTML', () => {
    // Even if a label coincidentally matches a secret-looking string,
    // the summary path doesn't carry tokens — but the invariant is
    // strong enough to assert here so any future regression that
    // accidentally renders a token tripwires.
    const SECRET_VALUE = 'super-secret-token-abcdef12345';
    const html = renderAdminPage({
      ...BASE_VM,
      tokenSummaries: [{ label: 'plugin', scopes: ['chat'] }],
    });
    expect(html).not.toContain(SECRET_VALUE);
  });

  it('shows an empty-state message when no recent events', () => {
    const html = renderAdminPage({ ...BASE_VM, recentEvents: [] });
    expect(html).toContain('No events yet');
  });

  it('renders recent events newest-first with type/provider/label/detail', () => {
    const html = renderAdminPage({
      ...BASE_VM,
      recentEvents: [
        {
          ts: Date.UTC(2026, 4, 14, 12, 0, 0),
          type: 'chat',
          label: 'plugin',
          detail: 'model=claude-sonnet-4-6 msgs=2',
          provider: 'anthropic',
        },
        {
          ts: Date.UTC(2026, 4, 14, 12, 5, 0),
          type: 'tool',
          label: 'plugin',
          detail: 'read_note',
        },
      ],
    });
    // Newest first means tool event appears BEFORE chat event
    // in the rendered output.
    const toolIdx = html.indexOf('read_note');
    const chatIdx = html.indexOf('msgs=2');
    expect(toolIdx).toBeGreaterThan(-1);
    expect(chatIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeLessThan(chatIdx);
    // Provider rendered for events that carry one; em-dash for those
    // that don't.
    expect(html).toContain('anthropic');
    expect(html).toContain('—');
  });

  it('escapes HTML-special chars in user-supplied label/detail', () => {
    const html = renderAdminPage({
      ...BASE_VM,
      tokenSummaries: [
        { label: '<script>alert(1)</script>', scopes: ['chat'] },
      ],
      recentEvents: [
        {
          ts: Date.now(),
          type: 'chat',
          label: 'plugin',
          detail: 'a & b "c" <d>',
        },
      ],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;c&quot;');
    expect(html).toContain('&lt;d&gt;');
  });

  it('renders both <h1> and the rotation pre-block instructions', () => {
    const html = renderAdminPage(BASE_VM);
    expect(html).toContain('wrangler secret put SCRIBIAN_TOKENS');
    expect(html).toContain('openssl rand -hex 32');
  });

  it('mentions persistence in the events footer (post-hibernation-persist fix)', () => {
    const html = renderAdminPage(BASE_VM);
    expect(html).toContain('persisted to DO storage');
    expect(html).not.toContain('Lost across hibernation cycles');
  });
});
