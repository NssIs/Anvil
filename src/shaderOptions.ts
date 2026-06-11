import { shaderAtmosphereOptionGroups } from "./shaderOptionsAtmosphere";
import { shaderLightingOptionGroups } from "./shaderOptionsLighting";
import { shaderMaterialsOptionGroups } from "./shaderOptionsMaterials";
import type { ShaderOptionCategory } from "./shaderOptionTypes";

const allGroups = [
  ...(shaderAtmosphereOptionGroups as unknown as ShaderOptionCategory[]),
  ...(shaderLightingOptionGroups as unknown as ShaderOptionCategory[]),
  ...shaderMaterialsOptionGroups,
];

export const shaderOptionGroups: ShaderOptionCategory[] = allGroups;

export const shaderOptionGroupById = new Map(shaderOptionGroups.map((group) => [group.id, group]));

export type { ShaderOptionCategory, ShaderOptionControl, ShaderOptionValue } from "./shaderOptionTypes";
