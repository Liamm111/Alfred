import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**', '**/drizzle/**', 'apps/web/next-env.d.ts', '**/playwright-report/**', '**/test-results/**'] },
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
  { files: ['scripts/**', '**/*.mjs', '**/scripts/**', '**/*.config.*', '**/*.test.ts', '**/e2e/**'], rules: { 'no-console': 'off' } },
);
