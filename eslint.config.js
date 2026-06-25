// ESLint flat config — focused on real bugs (undefined vars, duplicate keys, unreachable
// code), not stylistic churn. The front-end (public/) is a single inline-script HTML file
// linted separately by scripts/lint-frontend.mjs, so it's ignored here.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '.pglite/', 'uploads/', 'backups/', 'public/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
];
