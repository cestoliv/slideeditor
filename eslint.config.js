import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "coverage/"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // `tsc -p tsconfig.node.json` type checks path aliases but rewrites none of
    // them, so an alias here builds clean and then dies with ERR_MODULE_NOT_FOUND
    // in the shipped binary. This turns that runtime failure into a check failure.
    files: ["src/server/**/*.{ts,tsx}", "src/shared/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@shared",
                "@shared/*",
                "@server",
                "@server/*",
                "@web",
                "@web/*",
                "@assets",
                "@assets/*",
              ],
              message:
                "Nothing bundles src/server or src/shared, so path aliases survive into dist and break at runtime. Import relatively and carry the .js extension.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
  },
);
