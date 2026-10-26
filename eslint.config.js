// ============================================================
// ESLint — bug-finding only, not a style police.
//
// This repo had no lint configuration at all: 128k lines of React with no
// static gate, so classic React defects (hooks called conditionally, stale
// closures from missing effect deps, unused bindings left behind by a
// refactor) could only be found by reading every file.
//
// The rule set is deliberately narrow. Formatting is left alone — the codebase
// has a consistent hand style already and reflowing it would bury real findings
// in thousands of whitespace diffs. Everything enabled here describes a defect
// a reviewer would ask you to fix.
//
// Run: npm run lint        (report)
//      npm run lint:fix    (apply the safe fixes)
// ============================================================

import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'supabase/functions/**',   // Deno, separate runtime + its own type graph
      'wurx-buddy/**',           // dev-only scripts and design docs
      'scripts/**',              // one-off ops scripts, run by hand
      '*.config.js',
    ],
  },
  {
    files: ['src/**/*.{js,jsx}'],
    // The codebase carries ~37 `eslint-disable-next-line no-console` / `no-alert`
    // comments written for a lint setup that never existed. They are statements
    // of intent, and they go live the day someone enables those rules, so they
    // are kept. Reporting them is noise — and worse, `--fix` DELETES them,
    // including the react-hooks/exhaustive-deps suppressions that mark
    // deliberately once-only effects.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.serviceworker },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,

      // ── Real React defects ──────────────────────────────────
      // A hook behind a condition or loop desynchronises the hook order and
      // corrupts state across renders. Never acceptable.
      'react-hooks/rules-of-hooks': 'error',
      // A missing dep means the effect closes over a stale value. This is the
      // single most common source of "it shows the old number until I
      // refresh" in this app, so it is on — as a warning, because a few call
      // sites legitimately want a once-only effect.
      'react-hooks/exhaustive-deps': 'warn',
      'react/jsx-key': 'error',               // list reconciliation bugs
      'react/jsx-no-duplicate-props': 'error',
      'react/jsx-no-undef': 'error',
      'react/no-direct-mutation-state': 'error',
      'react/no-children-prop': 'error',

      // ── Dead and broken code ────────────────────────────────
      'no-unused-vars': ['warn', {
        args: 'none',                 // unused params are often documentation
        varsIgnorePattern: '^_',
        caughtErrors: 'none',         // `catch {}` is used deliberately here
        ignoreRestSiblings: true,     // the {a, ...rest} omit idiom
      }],
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      // `catch {}` is a deliberate idiom here for genuinely best-effort work
      // (Cache API blocked, execCommand('copy') unsupported, a telemetry POST
      // that must never break a user action). Allowed; a bare empty block
      // anywhere else is still an error.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Cosmetic, not a defect: a redundant `\-` inside a character class
      // behaves identically. Warn so it gets tidied opportunistically rather
      // than making the gate red on working regexes.
      'no-useless-escape': 'warn',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-sparse-arrays': 'error',
      'no-empty-pattern': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'require-atomic-updates': 'off',   // too noisy on async React handlers

      // JSX uses the component identifier, which the base rule cannot see.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'off',     // new JSX transform
      'react/react-in-jsx-scope': 'off', // ditto
    },
  },
];
