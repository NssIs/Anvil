// Validates the shader pack against extreme option configurations: every
// toggle flipped, every select at its first/last entry, every range at its
// min/max. Catches GLSL that only compiles with the default options.
//
//   node scripts/validate-shaderpack-variants.mjs

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shadersDir = resolve(root, "src-tauri/shaderpack/shaders");
const tmpDir = resolve(root, "node_modules/.anvil/glsl-variants");
mkdirSync(tmpDir, { recursive: true });

const outFile = resolve(root, "node_modules/.anvil/shader-codegen-variants.mjs");
await build({
  entryPoints: [resolve(root, "src/shaderOptionsCodegen.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
});
const { buildOptionsGlsl, defaultVisualSettings } = await import(pathToFileURL(outFile).href);

const variants = {
  low: (control) => {
    if (control.kind === "toggle") return false;
    if (control.kind === "select") return (control.options ?? [""])[0];
    if (control.kind === "color") return "#000000";
    return control.min ?? 0;
  },
  high: (control) => {
    if (control.kind === "toggle") return true;
    if (control.kind === "select") return (control.options ?? [""]).slice(-1)[0];
    if (control.kind === "color") return "#ffffff";
    return control.max ?? 1;
  },
  flipped: (control) => {
    if (control.kind === "toggle") return !control.value;
    if (control.kind === "select") {
      const options = control.options ?? [""];
      const index = options.indexOf(String(control.value));
      return options[(index + 1) % options.length];
    }
    return control.value;
  },
};

const programs = [];
const walk = (dir, prefix = "") => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "lib" && entry !== "lang") walk(path, `${prefix}${entry}/`);
    } else if (/\.(vsh|fsh)$/.test(entry)) {
      programs.push({ path, name: `${prefix}${entry}` });
    }
  }
};
walk(shadersDir);

let failures = 0;
for (const [variantName, resolver] of Object.entries(variants)) {
  const optionsGlsl = buildOptionsGlsl("1.21", defaultVisualSettings(), resolver);

  const resolveIncludes = (source, seen = new Set()) =>
    source.replace(/^[ \t]*#include\s+"([^"]+)"[ \t]*$/gm, (line, includePath) => {
      if (includePath === "/anvil_options.glsl") {
        if (seen.has(includePath)) return "";
        seen.add(includePath);
        return optionsGlsl;
      }
      const filePath = join(shadersDir, includePath.replace(/^\//, ""));
      if (seen.has(filePath)) return "";
      seen.add(filePath);
      return resolveIncludes(readFileSync(filePath, "utf8"), seen);
    });

  for (const program of programs) {
    const stage = program.name.endsWith(".vsh") ? "vert" : "frag";
    const resolved = resolveIncludes(readFileSync(program.path, "utf8"));
    const tmpFile = join(tmpDir, `${variantName}__${program.name.replace(/\//g, "__")}.${stage}`);
    writeFileSync(tmpFile, resolved);
    try {
      execFileSync("glslangValidator", [tmpFile], { stdio: "pipe" });
    } catch (error) {
      failures += 1;
      console.error(`FAIL [${variantName}] ${program.name}`);
      console.error(String(error.stdout ?? error.message));
    }
  }
}

if (failures) {
  console.error(`${failures} variant program compiles failed.`);
  process.exit(1);
}
console.log(`Variants OK: ${programs.length} programs × ${Object.keys(variants).length} extreme configurations compile.`);
