import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Build identifier (UTC timestamp + parent git SHA) injected into the console
// banner so the exact loaded build is identifiable at a glance - a newer stamp
// after a HACS update proves the fresh build actually loaded (defeats stale cache).
const buildId = (() => {
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

    try {
        return `${stamp}Z ${execSync("git rev-parse --short HEAD").toString().trim()}`;
    } catch {
        return `${stamp}Z`;
    }
})();

const defines = {
    __VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(buildId)
};

// Deliberately ordered after the TypeScript transform: by then the `declare const`
// lines are gone and only the real usages remain, so a plain textual substitution
// is safe and no extra dependency is needed.
const defineBuildConstants = {
    name: "define-build-constants",
    transform(code) {
        let result = code;

        for (const [token, value] of Object.entries(defines)) {
            if (result.includes(token)) {
                result = result.split(token).join(value);
            }
        }

        return result === code ? null : { code: result, map: null };
    }
};

export default {
    input: "src/mammotion-map-card.ts",
    output: {
        dir: "dist",
        format: "es",
        generatedCode: "es2015"
    },
    plugins: [
        typescript(),
        defineBuildConstants,
        terser()
    ]
};
