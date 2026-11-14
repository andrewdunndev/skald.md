# Security Policy

Skald is a direct-only Obsidian plugin: it talks straight from your device to
your chosen model provider using **your** API key, with no Skald-operated
backend. The architecture and trust model are documented in
[`docs/security-model.md`](docs/security-model.md) — read it first; it explains
why your key lives in Obsidian's per-device secret storage and what that
means.

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Report privately through GitHub's private vulnerability reporting
(Security tab of [andrewdunndev/skald.md](https://github.com/andrewdunndev/skald.md),
"Report a vulnerability"), or email **andrew@dunn.dev** with
`[skald security]` in the subject.

Please include: what you found, how to reproduce it, the affected version, and
the impact you foresee. A proof-of-concept helps but is not required.

There is no SLA: this is a single-maintainer project, maintained as time
allows. Confirmed issues are fixed in the next release, and reporters are
credited if they want it.

## In scope

- The plugin code (`packages/plugin`).
- Anything that could leak your API key, exfiltrate vault contents, execute an
  unapproved vault write, or run a prompt-injected action without approval.
- Build/supply-chain issues that would ship malicious or unexpected code in the
  released `main.js`.

## Out of scope

- Vulnerabilities in the **model providers** themselves (Anthropic, OpenRouter,
  or any OpenAI-compatible endpoint you point Skald at) — report those upstream.
- The inherent trust in your own configured endpoint and key: Skald sends your
  key and prompts to the provider/base-URL **you** choose. A hostile endpoint
  you configure is your trust decision, not a Skald vulnerability.
- Risks that require an attacker who already controls your device or a
  plugin running in your Obsidian (i.e. local device compromise).

## Supported versions

Skald is pre-1.0. Security fixes target the **latest released version** only.
There are no backports to older pre-release tags.
