import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  { ignores: ['**/*.test.ts'] },
  ...obsidianmd.configs.recommended,
  {
    files: ['packages/plugin/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.*'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Declarative settings need Obsidian 1.13; minAppVersion is 1.11.4.
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
      // The command is named "Run slash command"; slash command is the feature's name.
      'obsidianmd/commands/no-command-in-command-name': 'off',
      '@typescript-eslint/no-deprecated': 'off',
      'obsidianmd/ui/sentence-case': ['warn', { brands: ['Skald', 'Anthropic', 'OpenRouter', 'OpenAI', 'Claude', 'ID', 'Markdown'], ignoreRegex: ['^https?://', '^[a-z0-9.-]+(/[\\w.-]+)+$', '^[a-z]+[0-9.]+-[0-9a-z-]+$'] }],
      // Type-hygiene rules stay off; tsc is the type gate.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
    },
  },
  {
    // Streaming needs fetch; requestUrl buffers the whole response.
    files: ['packages/plugin/src/direct-transport.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
]);
