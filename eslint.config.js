import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "dist/**", "build/**"],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // This is a small Node tool; console output is expected.
      "no-console": "off",
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // This repo intentionally uses empty `catch {}` in a few places.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // The code intentionally includes control-char ranges (e.g. \u0000-\u001F).
      "no-control-regex": "off",
    },
  },
];
