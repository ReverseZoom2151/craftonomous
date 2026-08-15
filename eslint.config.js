// Flat ESLint config for Craftonomous.
//
// Deliberately uses the *non*-type-checked recommended preset: linting stays
// fast and does not require a second TypeScript program build. Type-level
// correctness is the job of `npm run typecheck`, which runs the compiler with
// `strict` on and is the authority on types.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'reference_repos/**',
      'coverage/**',
      '**/*.tsbuildinfo',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // Unused variables are already an error under tsc's `noUnusedLocals` /
      // `noUnusedParameters`. Keep the ESLint copy as a warning and honour the
      // leading-underscore convention for intentionally unused bindings.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // `import type` usage is enforced structurally by
      // `verbatimModuleSyntax`; no need to duplicate the diagnostic here.
      '@typescript-eslint/consistent-type-imports': 'off',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  {
    files: ['tests/**/*.ts'],
    rules: {
      // Tests deliberately poke at internals and construct partial doubles.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    files: ['*.js', '*.config.ts', 'vitest.config.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
