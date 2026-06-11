export type ShaderOptionKind = "range" | "toggle" | "color" | "select";

export type ShaderOptionValue = number | boolean | string;

export type ShaderOptionControl = {
  id: string;
  label: string;
  description?: string;
  kind: ShaderOptionKind;
  value: ShaderOptionValue;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** Minecraft version this control first becomes available on (Iris). */
  minVersion?: string;
};

export type ShaderOptionSection = {
  title: string;
  controls: ShaderOptionControl[];
};

export type ShaderOptionCategory = {
  id: string;
  title: string;
  summary: string;
  sections: ShaderOptionSection[];
  /** Minecraft version this whole category first becomes available on (Iris). */
  minVersion?: string;
};
