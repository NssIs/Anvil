// Syntax-validates every shader program in the pack with glslangValidator,
// resolving OptiFine/Iris-style absolute #include paths first.
//
//   node scripts/validate-shaderpack.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shadersDir = resolve(root, "src-tauri/shaderpack/shaders");
const tmpDir = resolve(root, "node_modules/.anvil/glsl-validate");
mkdirSync(tmpDir, { recursive: true });

const resolveIncludes = (source, seen = new Set()) =>
  source.replace(/^[ \t]*#include\s+"([^"]+)"[ \t]*$/gm, (line, includePath) => {
    const filePath = join(shadersDir, includePath.replace(/^\//, ""));
    if (seen.has(filePath)) return "";
    seen.add(filePath);
    return resolveIncludes(readFileSync(filePath, "utf8"), seen);
  });

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
for (const program of programs) {
  const stage = program.name.endsWith(".vsh") ? "vert" : "frag";
  const resolved = resolveIncludes(readFileSync(program.path, "utf8"));
  const tmpFile = join(tmpDir, `${program.name.replace(/\//g, "__")}.${stage}`);
  writeFileSync(tmpFile, resolved);
  try {
    execFileSync("glslangValidator", [tmpFile], { stdio: "pipe" });
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${program.name}`);
    console.error(String(error.stdout ?? error.message));
  }
}

if (failures) {
  console.error(`${failures} of ${programs.length} programs failed validation.`);
  process.exit(1);
}
console.log(`GLSL OK: all ${programs.length} programs compile.`);
