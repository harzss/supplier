import typescriptEslint from '@typescript-eslint/eslint-plugin';

export default [
  { ignores: ['dist/**', 'coverage/**'] },
  ...typescriptEslint.configs['flat/recommended'],
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
];
