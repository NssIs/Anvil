import type { ShaderOptionCategory, ShaderOptionControl } from "./shaderOptionTypes";

// Every control in this catalog maps to a #define (id upper-cased, dashes to
// underscores) that the generated shader pack genuinely consumes. If an option
// cannot be implemented for real in GLSL, it does not belong in this file.

const range = (
  id: string,
  label: string,
  description: string,
  value: number,
  min: number,
  max: number,
  step = 0.01,
  minVersion?: string,
): ShaderOptionControl => ({ id, label, description, kind: "range", value, min, max, step, minVersion });

const toggle = (
  id: string,
  label: string,
  description: string,
  value: boolean,
  minVersion?: string,
): ShaderOptionControl => ({ id, label, description, kind: "toggle", value, minVersion });

const color = (
  id: string,
  label: string,
  description: string,
  value: string,
  minVersion?: string,
): ShaderOptionControl => ({ id, label, description, kind: "color", value, minVersion });

const select = (
  id: string,
  label: string,
  description: string,
  value: string,
  options: string[],
  minVersion?: string,
): ShaderOptionControl => ({ id, label, description, kind: "select", value, options, minVersion });

export const shaderMaterialsOptionGroups: ShaderOptionCategory[] = [
  // --- Materials & surfaces --------------------------------------------------
  {
    id: "water",
    title: "Water",
    summary: "Waves, tint, clarity, and surface detail of the water layer.",
    sections: [
      {
        title: "Waves",
        controls: [
          toggle("water-enabled", "Custom water", "Turns Anvil's water rendering on or off.", true),
          range("water-wave-height", "Wave height", "How tall the vertex waves on the water surface are.", 0.32, 0, 1),
          range("water-wave-speed", "Wave speed", "How fast the water surface waves travel.", 0.4, 0, 1),
          range("water-wave-scale", "Wave scale", "Size of the wave pattern — small ripples up to broad swells.", 0.5, 0, 1),
        ],
      },
      {
        title: "Color",
        controls: [
          color("water-tint", "Water tint", "Color the water surface is shifted toward.", "#2f8fb8"),
          range("water-tint-strength", "Tint strength", "How strongly the tint replaces the vanilla water color.", 0.45, 0, 1),
          range("water-clarity", "Clarity", "Higher values make the surface more transparent.", 0.62, 0, 1),
          range("water-detail", "Surface detail", "Micro-contrast that keeps the water texture readable.", 0.48, 0, 1),
        ],
      },
    ],
  },
  {
    id: "reflections",
    title: "Reflections",
    summary: "Sky and screen-space reflections on the water surface.",
    minVersion: "1.20",
    sections: [
      {
        title: "Reflection model",
        controls: [
          toggle("reflections-enabled", "Reflections", "Enables reflections on water surfaces.", true),
          select("reflections-mode", "Mode", "Sky only is cheapest; screen space mirrors the scene; hybrid blends both.", "Hybrid", ["Sky only", "Screen space", "Hybrid"]),
          range("reflections-strength", "Strength", "Overall intensity of the reflection layer.", 0.55, 0, 1),
          range("reflections-fresnel", "Fresnel", "How much reflections concentrate at grazing view angles.", 0.65, 0, 1),
        ],
      },
      {
        title: "Quality",
        controls: [
          range("reflections-roughness", "Roughness", "Blurs and perturbs reflections with the wave surface.", 0.25, 0, 1),
          color("reflections-sky-tint", "Sky tint", "Tint of the reflected sky component.", "#a7d8ff"),
          range("reflections-distance", "Ray distance", "How far the screen-space rays march before falling back to sky.", 0.74, 0, 1),
          select("reflections-quality", "Quality", "Number of screen-space ray steps.", "High", ["Low", "Medium", "High", "Ultra"]),
        ],
      },
    ],
  },
  {
    id: "refraction",
    title: "Refraction",
    summary: "Bends the scene seen through water for a glassy look.",
    sections: [
      {
        title: "Refraction",
        controls: [
          toggle("refraction-enabled", "Refraction", "Distorts the scene visible through the water surface.", true),
          range("refraction-strength", "Strength", "How far the underwater image is displaced.", 0.35, 0, 1),
          range("refraction-wave-influence", "Wave influence", "How much the wave pattern drives the distortion.", 0.5, 0, 1),
          range("refraction-dispersion", "Dispersion", "Splits color channels slightly for a prismatic edge.", 0.15, 0, 1),
          range("refraction-depth-fade", "Depth fade", "Reduces distortion for objects close behind the surface.", 0.5, 0, 1),
        ],
      },
    ],
  },
  {
    id: "pbr",
    title: "PBR",
    summary: "Uses labPBR resource-pack normal and specular maps when present.",
    minVersion: "1.20",
    sections: [
      {
        title: "Material maps",
        controls: [
          toggle("pbr-enabled", "PBR materials", "Reads labPBR normal/specular maps from your resource pack.", true),
          range("pbr-specular-strength", "Specular strength", "Intensity of specular highlights from the specular map.", 0.5, 0, 1),
          range("pbr-normal-strength", "Normal strength", "How strongly normal maps bend the lighting.", 0.6, 0, 1),
          range("pbr-emissive-strength", "Emissive strength", "Brightness of labPBR emissive pixels.", 0.6, 0, 1),
          range("pbr-fallback-shine", "Fallback shine", "Procedural gloss used when no specular map exists.", 0.2, 0, 1),
        ],
      },
    ],
  },
  {
    id: "parallax",
    title: "Surface relief",
    summary: "Stylized depth shading generated from the block texture itself.",
    sections: [
      {
        title: "Relief",
        controls: [
          toggle("parallax-enabled", "Surface relief", "Adds emboss-style depth shading derived from texture luminance.", true),
          range("parallax-depth", "Depth", "Strength of the relief shading.", 0.3, 0, 1),
          range("parallax-softness", "Softness", "Smooths the relief so pixel edges stay clean.", 0.5, 0, 1),
          range("parallax-distance", "Fade distance", "Fades the effect out with distance from the camera.", 0.6, 0, 1),
        ],
      },
    ],
  },
  {
    id: "wetness",
    title: "Wetness",
    summary: "Rain-soaked surfaces: darkening, gloss, and puddles.",
    sections: [
      {
        title: "Rain response",
        controls: [
          toggle("wetness-enabled", "Wet surfaces", "Lets rain visibly soak terrain surfaces.", true),
          range("wetness-darkening", "Darkening", "How much wet blocks darken.", 0.4, 0, 1),
          range("wetness-gloss", "Gloss", "Specular sheen on soaked surfaces.", 0.5, 0, 1),
          range("wetness-puddles", "Puddles", "Noise-driven puddle patches on flat ground.", 0.35, 0, 1),
          range("wetness-response", "Response", "How strongly surfaces react as rain starts and stops.", 0.6, 0, 1),
        ],
      },
    ],
  },
  {
    id: "terrain",
    title: "Terrain",
    summary: "Base terrain shading: ambient occlusion, contrast, and distance haze.",
    sections: [
      {
        title: "Shading",
        controls: [
          toggle("terrain-enabled", "Terrain shading", "Enables Anvil's terrain shading adjustments.", true),
          range("terrain-vanilla-ao", "Vanilla AO", "Strength of Minecraft's baked corner shading.", 0.5, 0, 1),
          range("terrain-contrast", "Contrast", "Light/shade contrast on terrain surfaces.", 0.5, 0, 1),
          range("terrain-saturation", "Saturation", "Color richness of terrain blocks.", 0.5, 0, 1),
          range("terrain-distance-desat", "Distance desaturation", "Gently washes out far terrain for aerial perspective.", 0.3, 0, 1),
        ],
      },
    ],
  },
  {
    id: "translucency",
    title: "Translucency",
    summary: "Light passing through leaves, glass, and ice.",
    sections: [
      {
        title: "Translucent light",
        controls: [
          toggle("translucency-enabled", "Translucency", "Enables translucent material treatments.", true),
          range("translucency-leaf-glow", "Leaf glow", "Sunlight lift on foliage as if light passes through leaves.", 0.4, 0, 1),
          range("translucency-glass-clarity", "Glass clarity", "Makes glass cleaner and more transparent.", 0.5, 0, 1),
          range("translucency-glass-tint", "Glass tint", "How strongly stained glass colors what's behind it.", 0.5, 0, 1),
          range("translucency-ice-shine", "Ice shine", "Specular sparkle on ice surfaces.", 0.4, 0, 1),
        ],
      },
    ],
  },

  // --- World detail ----------------------------------------------------------
  {
    id: "foliage",
    title: "Foliage",
    summary: "Color treatment of grass, leaves, and plants.",
    sections: [
      {
        title: "Foliage color",
        controls: [
          toggle("foliage-enabled", "Foliage color", "Enables foliage color adjustments.", true),
          range("foliage-saturation", "Saturation", "Color richness of grass and leaves.", 1.0, 0, 2),
          range("foliage-brightness", "Brightness", "Brightness lift on foliage.", 1.0, 0.5, 1.5),
          color("foliage-tint", "Tint", "Color the foliage is pulled toward.", "#7ee787"),
          range("foliage-tint-amount", "Tint amount", "How strongly the tint is applied.", 0, 0, 1),
        ],
      },
    ],
  },
  {
    id: "wind",
    title: "Wind",
    summary: "Waving leaves and plants, with storm gusts.",
    sections: [
      {
        title: "Waving",
        controls: [
          toggle("wind-enabled", "Wind", "Enables vertex waving of foliage.", true),
          range("wind-strength", "Strength", "How far leaves and plants sway.", 0.45, 0, 1),
          range("wind-speed", "Speed", "How fast the sway animation runs.", 0.4, 0, 1),
          toggle("wind-leaves", "Wave leaves", "Applies wind to tree leaves.", true),
          toggle("wind-plants", "Wave plants", "Applies wind to grass, flowers, and crops.", true),
          range("wind-rain-boost", "Storm boost", "Extra gusting while it rains.", 0.5, 0, 1),
        ],
      },
    ],
  },
  {
    id: "lava",
    title: "Lava",
    summary: "Lava glow, pulse, and contrast.",
    sections: [
      {
        title: "Lava look",
        controls: [
          toggle("lava-enabled", "Lava glow", "Enables Anvil's lava treatment.", true),
          range("lava-glow", "Glow", "Emissive brightness of lava.", 0.7, 0, 1.5),
          color("lava-tint", "Tint", "Color of the lava glow.", "#ff7b42"),
          range("lava-pulse", "Pulse", "Slow brightness pulsing of the molten surface.", 0.3, 0, 1),
          range("lava-contrast", "Contrast", "Contrast between crust and molten cracks.", 0.4, 0, 1),
        ],
      },
    ],
  },
  {
    id: "particles",
    title: "Particles",
    summary: "Brightness and color of particle effects.",
    sections: [
      {
        title: "Particles",
        controls: [
          toggle("particles-enabled", "Particle treatment", "Enables particle adjustments.", true),
          range("particles-brightness", "Brightness", "Overall particle brightness.", 1.0, 0, 1.5),
          range("particles-emissive-boost", "Emissive boost", "Extra glow on bright particles like flames and embers.", 0.4, 0, 1),
          range("particles-saturation", "Saturation", "Color richness of particles.", 1.0, 0, 2),
        ],
      },
    ],
  },
  {
    id: "entities",
    title: "Entities",
    summary: "Mob and player lighting: brightness, rim light, hurt flash.",
    sections: [
      {
        title: "Entity lighting",
        controls: [
          toggle("entities-enabled", "Entity treatment", "Enables entity lighting adjustments.", true),
          range("entities-brightness", "Brightness", "Overall entity brightness.", 1.0, 0.5, 1.5),
          range("entities-rim-light", "Rim light", "Subtle edge light that separates mobs from the background.", 0.3, 0, 1),
          range("entities-hurt-flash", "Hurt flash", "Intensity of the red damage flash.", 0.6, 0, 1),
          range("entities-saturation", "Saturation", "Color richness of entities.", 1.0, 0, 2),
        ],
      },
    ],
  },
  {
    id: "handheld",
    title: "Handheld",
    summary: "Held-item rendering and dynamic held-torch light.",
    sections: [
      {
        title: "Held light",
        controls: [
          toggle("handheld-enabled", "Handheld light", "Lets held torches and lanterns light the world around you.", true),
          range("handheld-light-strength", "Light strength", "Brightness of the held light source.", 0.6, 0, 1),
          color("handheld-light-tint", "Light tint", "Color of the held light.", "#ffb15c"),
          range("handheld-light-distance", "Light distance", "Reach of the held light.", 0.5, 0, 1),
          range("handheld-brightness", "Item brightness", "Brightness of the held item itself.", 1.0, 0.5, 1.5),
        ],
      },
    ],
  },
  {
    id: "portals",
    title: "Portals",
    summary: "Nether portal shimmer and glow.",
    sections: [
      {
        title: "Portal look",
        controls: [
          toggle("portals-enabled", "Portal treatment", "Enables the portal shimmer effect.", true),
          range("portals-shimmer", "Shimmer", "Animated swirl strength inside the portal.", 0.5, 0, 1),
          color("portals-tint", "Tint", "Portal glow color.", "#a371f7"),
          range("portals-glow", "Glow", "Emissive brightness of the portal surface.", 0.5, 0, 1),
          range("portals-speed", "Speed", "Animation speed of the shimmer.", 0.4, 0, 1),
        ],
      },
    ],
  },
  {
    id: "biomes",
    title: "Biomes",
    summary: "Treatment of Minecraft's biome grass and foliage tints.",
    sections: [
      {
        title: "Biome tint",
        controls: [
          toggle("biomes-enabled", "Biome tint treatment", "Adjusts the biome color tint baked into terrain.", true),
          range("biomes-saturation", "Saturation", "Richness of biome tinting.", 1.0, 0, 2),
          range("biomes-contrast", "Contrast", "Contrast between differently-tinted biome areas.", 0.45, 0, 1),
          range("biomes-shift", "Hue shift", "Rotates biome tint hues — negative is cooler, positive warmer.", 0, -0.5, 0.5),
        ],
      },
    ],
  },

  // --- Post-processing ---------------------------------------------------------
  {
    id: "color-grade",
    title: "Color grade",
    summary: "Temperature, tint, vibrance, and lift/gamma/gain.",
    sections: [
      {
        title: "Balance",
        controls: [
          toggle("color-grade-enabled", "Color grade", "Enables the color grading stage.", true),
          range("color-grade-temperature", "Temperature", "Warm/cool white balance.", 0, -1, 1),
          range("color-grade-tint", "Tint", "Green/magenta balance.", 0, -1, 1),
          range("color-grade-vibrance", "Vibrance", "Boosts muted colors more than saturated ones.", 0.2, -1, 1),
        ],
      },
      {
        title: "Tone",
        controls: [
          range("color-grade-lift", "Lift", "Raises or lowers the shadows.", 0, -0.5, 0.5),
          range("color-grade-gamma", "Gamma", "Midtone brightness curve.", 1.0, 0.5, 2),
          range("color-grade-gain", "Gain", "Highlight scaling.", 1.0, 0.5, 2),
        ],
      },
    ],
  },
  {
    id: "exposure",
    title: "Exposure",
    summary: "Exposure value, tonemapping, and night lift.",
    sections: [
      {
        title: "Exposure",
        controls: [
          toggle("exposure-enabled", "Exposure stage", "Enables exposure and tonemapping.", true),
          range("exposure-value", "Exposure (EV)", "Brightens or darkens the whole image in stops.", 0, -2, 2, 0.05),
          select("exposure-tonemap", "Tonemap", "Curve that maps bright values into displayable range.", "Filmic", ["None", "Reinhard", "Filmic", "ACES"]),
          range("exposure-white-point", "White point", "Brightness level that maps to pure white.", 1.0, 0.5, 2),
          range("exposure-night-lift", "Night lift", "Gently lifts very dark night scenes for readability.", 0.2, 0, 1),
        ],
      },
    ],
  },
  {
    id: "contrast",
    title: "Contrast",
    summary: "Contrast curve with pivot and rolloff control.",
    sections: [
      {
        title: "Contrast curve",
        controls: [
          toggle("contrast-enabled", "Contrast stage", "Enables the contrast curve.", true),
          range("contrast-amount", "Amount", "Overall contrast strength.", 1.0, 0.5, 1.5),
          range("contrast-pivot", "Pivot", "Brightness level that stays fixed while contrast changes.", 0.5, 0.2, 0.8),
          range("contrast-shadow-crush", "Shadow crush", "Deepens the darkest shadows.", 0, 0, 1),
          range("contrast-highlight-rolloff", "Highlight rolloff", "Softens the brightest highlights instead of clipping.", 0.3, 0, 1),
        ],
      },
    ],
  },
  {
    id: "depth-of-field",
    title: "Depth of field",
    summary: "Camera-style focus blur by distance.",
    sections: [
      {
        title: "Focus",
        controls: [
          toggle("depth-of-field-enabled", "Depth of field", "Blurs out-of-focus distances like a camera lens.", false),
          range("depth-of-field-strength", "Strength", "Overall blur intensity.", 0.5, 0, 1),
          select("depth-of-field-focus", "Focus mode", "Center auto focuses on what you look at; fixed uses the distance below.", "Center auto", ["Center auto", "Fixed distance"]),
          range("depth-of-field-focal-distance", "Focal distance", "Focus distance used in fixed mode.", 0.3, 0, 1),
          range("depth-of-field-max-blur", "Max blur", "Upper limit of the blur radius.", 0.4, 0, 1),
          select("depth-of-field-quality", "Quality", "Number of blur samples.", "Medium", ["Low", "Medium", "High", "Ultra"]),
        ],
      },
    ],
  },
  {
    id: "motion-blur",
    title: "Motion blur",
    summary: "Camera-motion blur from frame movement.",
    sections: [
      {
        title: "Blur",
        controls: [
          toggle("motion-blur-enabled", "Motion blur", "Blurs the image along camera movement.", false),
          range("motion-blur-strength", "Strength", "Length of the blur trail.", 0.35, 0, 1),
          select("motion-blur-samples", "Samples", "Number of samples along the motion vector.", "8", ["4", "8", "12", "16"]),
          range("motion-blur-translation", "Movement weight", "How much walking/flying contributes versus only looking around.", 0.6, 0, 1),
        ],
      },
    ],
  },
  {
    id: "lens-effects",
    title: "Lens effects",
    summary: "Vignette, chromatic aberration, grain, and sun glare.",
    sections: [
      {
        title: "Lens",
        controls: [
          toggle("lens-effects-enabled", "Lens effects", "Enables the lens effect stack.", true),
          range("lens-effects-vignette", "Vignette", "Darkens the screen corners.", 0.25, 0, 1),
          range("lens-effects-vignette-roundness", "Vignette roundness", "Shape of the vignette from oval to circular.", 0.5, 0, 1),
          range("lens-effects-chromatic-aberration", "Chromatic aberration", "Color fringing toward the screen edges.", 0.1, 0, 1),
          range("lens-effects-film-grain", "Film grain", "Animated fine noise over the image.", 0.08, 0, 1),
          range("lens-effects-sun-flare", "Sun glare", "Screen glare when looking toward the sun.", 0.2, 0, 1),
        ],
      },
    ],
  },
  {
    id: "sharpening",
    title: "Sharpening",
    summary: "Edge-aware sharpening of the final image.",
    sections: [
      {
        title: "Sharpen",
        controls: [
          toggle("sharpening-enabled", "Sharpening", "Enables final-image sharpening.", true),
          range("sharpening-amount", "Amount", "Sharpening strength.", 0.3, 0, 1),
          range("sharpening-radius", "Radius", "Distance of the sampling taps.", 0.5, 0, 1),
          range("sharpening-edge-protect", "Edge protect", "Limits sharpening on already-strong edges to avoid halos.", 0.5, 0, 1),
        ],
      },
    ],
  },
  {
    id: "screen-effects",
    title: "Screen effects",
    summary: "Underwater distortion and light-adaptive screen moods.",
    sections: [
      {
        title: "Situational",
        controls: [
          toggle("screen-effects-enabled", "Screen effects", "Enables situational screen effects.", true),
          range("screen-effects-underwater-distortion", "Underwater distortion", "Wavy view while underwater.", 0.4, 0, 1),
          range("screen-effects-underwater-tint", "Underwater tint", "Blue-green grade while submerged.", 0.5, 0, 1),
          range("screen-effects-night-desaturation", "Night desaturation", "Washes out color in darkness like human night vision.", 0.3, 0, 1),
          range("screen-effects-cave-darkening", "Cave darkening", "Deepens the mood in unlit caves.", 0.4, 0, 1),
        ],
      },
    ],
  },

  // --- Profiles & tuning -------------------------------------------------------
  {
    id: "quality-presets",
    title: "Quality presets",
    summary: "Global sample-count and effect-distance scaling.",
    sections: [
      {
        title: "Global quality",
        controls: [
          select("quality-presets-profile", "Profile", "Scales every effect's sample counts at once.", "Balanced", ["Performance", "Balanced", "Quality", "Ultra"]),
          range("quality-presets-effect-distance", "Effect distance", "Global multiplier on how far screen effects reach.", 0.74, 0, 1),
          select("quality-presets-noise-octaves", "Noise detail", "Octave count for clouds/mist noise.", "3", ["2", "3", "4", "5"]),
        ],
      },
    ],
  },
  {
    id: "performance",
    title: "Performance",
    summary: "Fast paths that trade fidelity for frame rate.",
    sections: [
      {
        title: "Fast paths",
        controls: [
          toggle("performance-fast-lighting", "Fast lighting", "Skips ambient occlusion and bounce-light gathering.", false),
          toggle("performance-simple-clouds", "Simple clouds", "Single-octave cloud noise.", false),
          toggle("performance-fast-water", "Fast water", "Disables screen-space reflection marching on water.", false),
          toggle("performance-single-tap-shadows", "Hard shadows", "One shadow sample instead of soft filtering.", false),
        ],
      },
    ],
  },
  {
    id: "debug",
    title: "Debug",
    summary: "Render-buffer inspection views for pack development.",
    sections: [
      {
        title: "Debug view",
        controls: [
          select("debug-view", "View", "Replaces the image with an internal buffer for inspection.", "Off", ["Off", "Depth", "Lightmap", "Ambient occlusion", "Shadow", "Material flags"]),
          range("debug-split", "Split", "Portion of the screen (from the right) showing the debug view.", 1.0, 0, 1),
        ],
      },
    ],
  },
];
