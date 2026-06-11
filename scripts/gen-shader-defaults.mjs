// Regenerates the committed default shader-pack option artifacts from the
// option catalogs, via the same codegen module the app uses at runtime.
//
//   node scripts/gen-shader-defaults.mjs
//
// Outputs (committed, used as backend templates):
//   src-tauri/shaderpack/shaders/anvil_options.glsl
//   src-tauri/shaderpack/shaders/shaders.properties
//   src-tauri/shaderpack/shaders/lang/en_us.lang

import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = resolve(root, "node_modules/.anvil/shader-codegen.mjs");

await build({
  entryPoints: [resolve(root, "src/shaderOptionsCodegen.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
});

const codegen = await import(pathToFileURL(outFile).href);
const { buildOptionsGlsl, buildShaderProperties, buildLangFile, defaultVisualSettings, defaultResolver } = codegen;

const shadersDir = resolve(root, "src-tauri/shaderpack/shaders");
await mkdir(resolve(shadersDir, "lang"), { recursive: true });

const write = async (path, contents) => {
  await writeFile(resolve(shadersDir, path), contents);
  console.log(`wrote shaders/${path}`);
};

await write("anvil_options.glsl", buildOptionsGlsl("1.21", defaultVisualSettings(), defaultResolver));
await write("shaders.properties", buildShaderProperties(defaultResolver));
await write("lang/en_us.lang", buildLangFile());
