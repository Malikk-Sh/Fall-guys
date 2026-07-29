// Конфигурация ESLint (flat config). Держим правила минимальными: цель — ловить настоящие ошибки
// (опечатки в именах, недостижимый код, забытые переменные), а не спорить о стиле — стилем занят Prettier.
'use strict';

const js = require('@eslint/js');
const globals = require('globals');

const commonRules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-console': 'off',
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error'
};

module.exports = [
  { ignores: ['node_modules/**', 'package-lock.json'] },

  // Клиент: браузерные ES-модули.
  {
    files: ['client/**/*.js', 'shared/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser }
    },
    rules: commonRules
  },

  // Сервер: CommonJS под Node.
  {
    files: ['server/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: commonRules
  },

  // Тесты и загрузчик: ESM под Node.
  {
    files: ['server/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: commonRules
  }
];
