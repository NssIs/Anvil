// Verifies that EVERY option in the shader option catalogs maps to a define
// (or engine const) that the GLSL shader pack actually consumes.
//
//   node scripts/check-shader-coverage.mjs

import { build } from "esbuild";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = resolve(root, "node_modules/.anvil/shader-coverage.mjs");

await build({
  entryPoints: [resolve(root, "src/shaderOptionsCodegen.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
});

const { optionDefineName, constNameForOption } = await import(pathToFileURL(outFile).href);
const { shaderOptionGroups } = await import(
  pathToFileURL(
    (await build({
      entryPoints: [resolve(root, "src/shaderOptions.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: resolve(root, "node_modules/.anvil/shader-options.mjs"),
    }),
    resolve(root, "node_modules/.anvil/shader-options.mjs")),
  ).href
);

// Gather every GLSL source in the pack except the generated options file
// (which *defines* the names — we want *consumers*).
const shadersDir = resolve(root, "src-tauri/shaderpack/shaders");
const sources = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else if (/\.(vsh|fsh|glsl)$/.test(entry) && entry !== "anvil_options.glsl") {
      sources.push(readFileSync(path, "utf8"));
    }
  }
};
walk(shadersDir);
const corpus = sources.join("\n");

// Engine consts (shadowMapResolution, sunPathRotation, …) are consumed by the
// shader loader itself — they count as used when declared in the generated
// options file.
const optionsFile = readFileSync(join(shadersDir, "anvil_options.glsl"), "utf8");

const missing = [];
let total = 0;
for (const group of shaderOptionGroups) {
  for (const section of group.sections) {
    for (const control of section.controls) {
      total += 1;
      const define = optionDefineName(control.id);
      const constName = constNameForOption(define);
      const name = constName ?? define;
      const used = constName
        ? new RegExp(`\\b${name}\\b`).test(corpus) || new RegExp(`const\\s+\\w+\\s+${name}\\b`).test(optionsFile)
        : new RegExp(`\\b${name}\\b`).test(corpus);
      if (!used) {
        missing.push(`${group.id} :: ${control.id} -> ${name}`);
      }
    }
  }
}

// The quick visual-builder defines must also be consumed.
for (const legacy of [
  "ANVIL_EXPOSURE", "ANVIL_CONTRAST", "ANVIL_SATURATION", "ANVIL_FOG", "ANVIL_BLOOM",
  "ANVIL_LIGHT_TINT", "ANVIL_SKY_TINT", "ANVIL_WATER_TINT", "ANVIL_BLOOM_PASS",
  "ANVIL_WAVING_FOLIAGE", "ANVIL_WATER_RIPPLES", "ANVIL_VIGNETTE", "ANVIL_SHARPEN",
]) {
  total += 1;
  if (!new RegExp(`\\b${legacy}\\b`).test(corpus)) {
    missing.push(`visual-builder :: ${legacy}`);
  }
}

if (missing.length) {
  console.error(`COVERAGE FAILED: ${missing.length} of ${total} options are not consumed by the shader pack:`);
  for (const entry of missing) console.error(`  - ${entry}`);
  process.exit(1);
}
console.log(`Coverage OK: all ${total} options are consumed by the shader pack.`);
