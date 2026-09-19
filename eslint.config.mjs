// Flat ESLint config for the whole monorepo (plan §9.3, SR-0.7).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import security from 'eslint-plugin-security';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const bannedChildProcess = {
  message: 'Shelling out is banned in app code (SR-X.13). Scripts under scripts/ are exempt.',
};

export default defineConfig(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**', 'reports/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'child_process', ...bannedChildProcess },
            { name: 'node:child_process', ...bannedChildProcess },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned (XSS, SR-2.3).',
        },
        {
          selector: "CallExpression[callee.object.name='sql'][callee.property.name='raw']",
          message: 'sql.raw() bypasses parameterization (SR-X.11).',
        },
      ],
    },
  },
  {
    // Plain JS (configs, scripts) is not part of any tsconfig project.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['scripts/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
  prettier,
);
