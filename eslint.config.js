import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["dist/**", "node_modules/**"]
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
        files: ["src/**/*.ts"],
        plugins: {
            "@stylistic": stylistic
        },
        languageOptions: {
            globals: globals.browser,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname
            }
        },
        rules: {
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unused-vars": ["warn", { args: "none" }],

            "arrow-body-style": ["error", "as-needed"],
            "block-scoped-var": "error",
            "curly": "error",
            "default-case-last": "error",
            "eqeqeq": "error",
            "no-labels": "error",
            "no-multi-assign": "error",
            "no-multi-str": "error",
            "no-new": "error",
            "no-new-wrappers": "error",
            "no-self-compare": "error",
            "no-sequences": "error",
            "no-unneeded-ternary": ["error", { defaultAssignment: false }],

            // Formatting rules were deprecated in ESLint core and are removed in v11.
            "@stylistic/brace-style": ["error", "1tbs"],
            "@stylistic/eol-last": ["error", "always"],
            "@stylistic/indent": ["error", 4, { SwitchCase: 1 }],
            "@stylistic/keyword-spacing": "error",
            "@stylistic/no-multi-spaces": ["error", { ignoreEOLComments: true }],
            "@stylistic/no-trailing-spaces": ["error", { ignoreComments: true }],
            "@stylistic/no-whitespace-before-property": "error",
            "@stylistic/operator-linebreak": ["error", "after", {
                overrides: { "?": "before", ":": "before", "|": "before", "&": "before" }
            }],
            "@stylistic/quotes": ["error", "double"],
            "@stylistic/semi": ["error", "always"]
        }
    },
    {
        files: ["*.js"],
        extends: [tseslint.configs.disableTypeChecked],
        languageOptions: {
            globals: globals.node
        }
    }
);
