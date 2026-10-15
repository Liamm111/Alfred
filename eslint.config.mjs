import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/node_modules/**', 'archive/**', '**/dist/**', '**/.next*/**', '**/coverage/**', '**/drizzle/**', 'apps/web/next-env.d.ts', '**/playwright-report/**', '**/test-results/**'] },
  { languageOptions: { globals: { ...globals.node } } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
      eqeqeq: 'error',
    },
  },
  // Contracts / store / auth were written against a looser lint profile: `any` at JSON/pg boundaries and `expect(...)` expressions.
  { files: ['packages/{contracts,store,auth}/**'], rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unused-expressions': 'off' } },
  { files: ['apps/zoom-surface/**/*.js'], languageOptions: { globals: { ...globals.browser } } },
  { files: ['scripts/**', '**/*.mjs', '**/scripts/**', '**/*.config.*', '**/*.test.ts', '**/e2e/**'], rules: { 'no-console': 'off' } },
);
