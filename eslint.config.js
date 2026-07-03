import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";

// Flat config for the React/TS frontend. `prettier` last disables any
// formatting rules that would fight Prettier (formatting is Prettier's job).
export default tseslint.config(
  { ignores: ["dist", "src-tauri", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // TypeScript already resolves identifiers, so `no-undef` only false-positives
    // (DOM globals in the app, Node globals in build scripts). Off everywhere per
    // typescript-eslint's own guidance; `tsc` is the real undefined-var gate.
    rules: { "no-undef": "off" },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // The two classic hook rules only — not react-hooks v7's newer
      // react-compiler checks, which flag intentional patterns here (e.g. a
      // buffered setState in an effect) and we don't target the compiler.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Vite HMR wants components exported alone; warn, don't block (our
      // components.tsx files deliberately also export helpers).
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // Ternary/short-circuit used purely for a side effect is idiomatic.
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowShortCircuit: true, allowTernary: true },
      ],
    },
  },
  prettier,
);
