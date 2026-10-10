import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'app/**', 'server/**', '.expo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // core and rules stay runnable in Node: no React or Expo (CLAUDE.md §5)
    files: ['packages/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-native', 'react-native-*', 'react/*'], message: 'No React in packages/*.' },
            { group: ['expo', 'expo-*', 'expo/*', '@expo/*'], message: 'No Expo in packages/*.' },
          ],
        },
      ],
    },
  },
);
