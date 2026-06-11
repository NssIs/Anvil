import { shaderOptionGroups } from "./shaderOptions";
import type { ShaderOptionCategory, ShaderOptionControl, ShaderOptionValue } from "./shaderOptionTypes";

// Shared generator for the shader pack's option artifacts. The visual builder
// and the default-template codegen script both go through this module, so the
// committed defaults and the app's generated files can never drift apart.

export type VisualSettings = {
  exposure: number;
  contrast: number;
  saturation: number;
  fog: number;
  bloom: number;
  lightColor: string;
  skyColor: string;
  waterColor: string;
  effects: {
    bloom: boolean;
    foliage: boolean;
    water: boolean;
    vignette: boolean;
    sharpen: boolean;
  };
};

export const defaultVisualSettings = (): VisualSettings => ({
  exposure: 1,
  contrast: 1,
  saturation: 1,
  fog: 0.35,
  bloom: 0.4,
  lightColor: "#ffe9c4",
  skyColor: "#8fc7ff",
  waterColor: "#2f6f8f",
  effects: {
    bloom: true,
    foliage: true,
    water: true,
    vignette: false,
    sharpen: false,
  },
});

export const optionDefineName = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

// Options that surface as OptiFine/Iris constants instead of #defines. The
// engine itself reads these (shadow map size, render distance of shadows, sun
// tilt, vanilla AO level), so they must be emitted as `const` declarations.
const CONST_OPTIONS: Record<string, { decl: "int" | "float"; name: string }> = {
  SHADOWS_RESOLUTION: { decl: "int", name: "shadowMapResolution" },
  SHADOWS_DISTANCE: { decl: "float", name: "shadowDistance" },
  SHADOWS_SUN_PATH_TILT: { decl: "float", name: "sunPathRotation" },
  TERRAIN_VANILLA_AO: { decl: "float", name: "ambientOcclusionLevel" },
};

export const constNameForOption = (defineName: string) => CONST_OPTIONS[defineName]?.name;

const decimalsForStep = (step: number) => {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
};

const formatNumber = (value: number, decimals: number) =>
  decimals <= 0 ? String(Math.round(value)) : value.toFixed(decimals);

// GLSL needs a decimal point or it treats the literal as an int — which errors
// in float expressions (e.g. a 6200 kelvin temperature).
export const glslFloat = (text: string) => (/[.eE]/.test(text) ? text : `${text}.0`);

export const hexToVec3 = (hex: string) => {
  const value = hex.replace("#", "");
  const channel = (start: number) => (parseInt(value.slice(start, start + 2), 16) || 0) / 255;
  return `${channel(0).toFixed(3)}, ${channel(2).toFixed(3)}, ${channel(4).toFixed(3)}`;
};

// Iris/OptiFine read the allowed values for an option from a trailing
// `// [a b c]` comment. The current value must be part of the list or the
// option shows up as broken in the in-game menu.
const rangeValueList = (control: ShaderOptionControl, current: number, decimals: number) => {
  const min = control.min ?? 0;
  const max = control.max ?? 1;
  const step = control.step ?? 0.01;
  const count = Math.floor((max - min) / step + 1.0001);
  const stride = Math.max(1, Math.ceil(count / 121));
  const values = new Set<string>();

  for (let index = 0; index < count; index += stride) {
    values.add(formatNumber(min + index * step, decimals));
  }
  values.add(formatNumber(max, decimals));
  values.add(formatNumber(control.value as number, decimals));
  values.add(formatNumber(current, decimals));

  return [...values]
    .map((text) => ({ text, value: Number(text) }))
    .sort((a, b) => a.value - b.value)
    .map((entry) => entry.text);
};

export type OptionResolver = (control: ShaderOptionControl) => ShaderOptionValue;

const optionLines = (control: ShaderOptionControl, resolve: OptionResolver): string[] => {
  const name = optionDefineName(control.id);
  const value = resolve(control);
  const constInfo = CONST_OPTIONS[name];

  if (control.kind === "toggle") {
    return [`#define ${name} ${value ? 1 : 0} // [0 1] ${control.label}`];
  }

  if (control.kind === "color") {
    return [`#define ${name} vec3(${hexToVec3(String(value))}) // ${control.label}`];
  }

  if (control.kind === "select") {
    const options = control.options ?? [];
    const index = Math.max(0, options.indexOf(String(value)));
    const list = options.map((_, optionIndex) => optionIndex).join(" ");
    return [`#define ${name} ${index} // [${list}] ${control.label}: ${value}`];
  }

  const decimals = decimalsForStep(control.step ?? 0.01);
  const raw = Number(value);
  const formatted = formatNumber(raw, decimals);
  const list = rangeValueList(control, raw, decimals).join(" ");

  if (constInfo) {
    const literal = constInfo.decl === "int" ? formatNumber(raw, 0) : glslFloat(formatted);
    return [`const ${constInfo.decl} ${constInfo.name} = ${literal}; // [${list}] ${control.label}`];
  }

  return [`#define ${name} ${glslFloat(formatted)} // [${list}] ${control.label}`];
};

const selectConstLines = (control: ShaderOptionControl, resolve: OptionResolver): string[] => {
  const name = optionDefineName(control.id);
  const constInfo = CONST_OPTIONS[name];

  if (!constInfo || control.kind !== "select") {
    return optionLines(control, resolve);
  }

  const options = control.options ?? [];
  const value = String(resolve(control));
  const literal = options.includes(value) ? value : String(control.value);
  const list = options.join(" ");
  return [`const ${constInfo.decl} ${constInfo.name} = ${literal}; // [${list}] ${control.label}`];
};

const linesForControl = (control: ShaderOptionControl, resolve: OptionResolver) =>
  control.kind === "select" ? selectConstLines(control, resolve) : optionLines(control, resolve);

export const buildOptionsGlsl = (
  version: string,
  settings: VisualSettings,
  resolve: OptionResolver,
): string => {
  const s = settings;
  const lines = [
    "#ifndef ANVIL_OPTIONS",
    "#define ANVIL_OPTIONS",
    "// Generated by Anvil's visual builder — every option as a #define.",
    "// Change options visually, or hand-edit this file (your edits win).",
    "// The shader passes #include this file and consume these macros.",
    `// Target: Iris · Minecraft ${version}`,
    "",
    "// --- Quick adjustments (visual builder & AI assistant) ---",
    `#define ANVIL_EXPOSURE ${s.exposure.toFixed(2)} // [0.00 0.10 0.20 0.30 0.40 0.50 0.60 0.70 0.80 0.90 1.00 1.10 1.20 1.30 1.40 1.50 1.60 1.70 1.80 1.90 2.00 2.25 2.50 2.75 3.00 ${s.exposure.toFixed(2)}]`,
    `#define ANVIL_CONTRAST ${s.contrast.toFixed(2)} // Quick contrast`,
    `#define ANVIL_SATURATION ${s.saturation.toFixed(2)} // Quick saturation`,
    `#define ANVIL_FOG ${s.fog.toFixed(2)} // Quick fog multiplier`,
    `#define ANVIL_BLOOM ${s.bloom.toFixed(2)} // Quick bloom multiplier`,
    `#define ANVIL_LIGHT_TINT vec3(${hexToVec3(s.lightColor)})`,
    `#define ANVIL_SKY_TINT vec3(${hexToVec3(s.skyColor)})`,
    `#define ANVIL_WATER_TINT vec3(${hexToVec3(s.waterColor)})`,
    `#define ANVIL_BLOOM_PASS ${s.effects.bloom ? 1 : 0} // [0 1]`,
    `#define ANVIL_WAVING_FOLIAGE ${s.effects.foliage ? 1 : 0} // [0 1]`,
    `#define ANVIL_WATER_RIPPLES ${s.effects.water ? 1 : 0} // [0 1]`,
    `#define ANVIL_VIGNETTE ${s.effects.vignette ? 1 : 0} // [0 1]`,
    `#define ANVIL_SHARPEN ${s.effects.sharpen ? 1 : 0} // [0 1]`,
    "",
  ];

  shaderOptionGroups.forEach((group) => {
    const groupLines: string[] = [];
    group.sections.forEach((section) => {
      section.controls.forEach((control) => {
        groupLines.push(...linesForControl(control, resolve));
      });
    });

    if (groupLines.length) {
      lines.push(`// --- ${group.title} ---`, ...groupLines, "");
    }
  });

  lines.push("#endif // ANVIL_OPTIONS", "");
  return lines.join("\n");
};

// ---- shaders.properties -----------------------------------------------------

const screenKeyForCategory = (category: ShaderOptionCategory) =>
  optionDefineName(category.id);

export const buildShaderProperties = (resolve: OptionResolver): string => {
  const sliders: string[] = [];
  const screens: string[] = [];
  const mainScreen: string[] = [];

  shaderOptionGroups.forEach((category) => {
    const key = screenKeyForCategory(category);
    const entries: string[] = [];

    category.sections.forEach((section) => {
      section.controls.forEach((control) => {
        const name = optionDefineName(control.id);
        const constInfo = CONST_OPTIONS[name];
        const optionName = constInfo ? constInfo.name : name;

        if (control.kind === "color") {
          return; // vec3 colors are edited in Anvil, not the in-game menu
        }
        if (control.kind === "range" || (constInfo && control.kind === "select")) {
          sliders.push(optionName);
        }
        entries.push(optionName);
      });
    });

    if (entries.length) {
      mainScreen.push(`[${key}]`);
      screens.push(`screen.${key}=${entries.join(" ")}`);
    }
  });

  // Suppress vanilla cloud geometry whenever a custom cloud style is active.
  const cloudsStyle = findControlValue("clouds-style", resolve);
  const cloudsVanilla = String(cloudsStyle) === "vanilla flat";

  return [
    "# Anvil shader pack — generated by the visual builder.",
    "# Option values live in anvil_options.glsl; this file lays out the in-game menu.",
    "",
    cloudsVanilla ? "clouds=on" : "clouds=off",
    "oldLighting=false",
    "separateAo=false",
    "",
    `sliders=${sliders.join(" ")}`,
    "",
    `screen=ANVIL_EXPOSURE ANVIL_BLOOM_PASS ANVIL_VIGNETTE ANVIL_SHARPEN <empty> <empty> ${mainScreen.join(" ")}`,
    ...screens,
    "",
  ].join("\n");
};

const findControlValue = (controlId: string, resolve: OptionResolver): ShaderOptionValue => {
  for (const group of shaderOptionGroups) {
    for (const section of group.sections) {
      for (const control of section.controls) {
        if (control.id === controlId) {
          return resolve(control);
        }
      }
    }
  }
  return "";
};

// ---- lang/en_us.lang ----------------------------------------------------------

export const buildLangFile = (): string => {
  const lines = [
    "# Generated by Anvil — readable names for the in-game shader menu.",
    "option.ANVIL_EXPOSURE=Quick exposure",
    "option.ANVIL_BLOOM_PASS=Quick bloom",
    "option.ANVIL_VIGNETTE=Quick vignette",
    "option.ANVIL_SHARPEN=Quick sharpen",
  ];

  shaderOptionGroups.forEach((category) => {
    lines.push(`screen.${screenKeyForCategory(category)}=${category.title}`);
    category.sections.forEach((section) => {
      section.controls.forEach((control) => {
        const name = optionDefineName(control.id);
        const constInfo = CONST_OPTIONS[name];
        const optionName = constInfo ? constInfo.name : name;

        if (control.kind === "color") {
          return;
        }
        lines.push(`option.${optionName}=${control.label}`);
        if (control.description) {
          lines.push(`option.${optionName}.comment=${control.description}`);
        }
        if (control.kind === "select" && !constInfo) {
          (control.options ?? []).forEach((option, index) => {
            lines.push(`value.${optionName}.${index}=${option}`);
          });
        }
      });
    });
  });

  lines.push("");
  return lines.join("\n");
};

export const defaultResolver: OptionResolver = (control) => control.value;
