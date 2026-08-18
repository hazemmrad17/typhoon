// ESLint 9 (flat config) — Typhon frontend.
// Objectif : attraper les vrais bugs (variables non définies, hooks cassés,
// imports inutilisés), pas le style — pas de prettier, la mise en forme reste
// libre. La config suit les presets `recommended` de typescript-eslint +
// react-hooks ; react-refresh est en warn (les chunks lazy s'en servent).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    // Artefacts de build et contenu statique (miroirs, landing.html, viewer).
    ignores: ['dist', 'node_modules', 'public', 'bim-viewer', 'src/vite-env.d.ts'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // `any` aux frontières typées (déclarations custom elements, données
      // de carte, réponses API) est toléré en warn : le gate CI ne bloque que
      // sur les erreurs (vraies boulettes), pas sur l'ambition de typage.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Convention : un identifiant préfixé `_` est volontairement inutilisé
      // (ex. paramètre de middleware non consommé).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
