import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'logs/**',
      'data/**',
      'assets/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // Keep cleanup findings visible without blocking releases.
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          varsIgnorePattern: '^_',
        },
      ],
      // These rules target patterns that commonly become runtime bugs.
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-promise-executor-return': 'error',
      'no-useless-assignment': 'warn',
      'require-atomic-updates': 'warn',
    },
  },
];
