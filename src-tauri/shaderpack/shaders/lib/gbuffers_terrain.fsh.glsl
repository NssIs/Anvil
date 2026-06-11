// Terrain fragment pass body — included by gbuffers_terrain.fsh (per dimension).
// Consumes the Sunlight, Moonlight, Block light, Foliage, Biomes, Wetness,
// Surface relief, PBR, Lava, Translucency and Emissive option groups.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D texture;
uniform sampler2D normals;
uniform sampler2D specular;
uniform ivec2 atlasSize;
uniform vec3 sunPosition;
uniform vec3 moonPosition;
uniform vec3 upPosition;
uniform float sunAngle;
uniform float rainStrength;
uniform float wetness;
uniform float frameTimeCounter;
uniform int moonPhase;

varying vec2 texcoord;
varying vec2 lmcoord;
varying vec4 vertexColor;
varying vec3 viewNormal;
varying vec3 viewPosV;
varying vec3 worldPos;
varying float materialFlag;

// Sun color from temperature (kelvin) plus tint/saturation options.
vec3 anvilSunColor() {
    float warmth = clamp((6500.0 - SUNLIGHT_TEMPERATURE) / 3500.0, -1.0, 1.0);
    vec3 sun = SUNLIGHT_TINT * vec3(1.0 + warmth * 0.25, 1.0, 1.0 - warmth * 0.25);
    return anvilSaturate(sun, clamp(1.0 + SUNLIGHT_SATURATION, 0.0, 2.0));
}

// Moon brightness factor from the phase options (moonPhase: 0 = full).
float anvilMoonPhaseFactor() {
#if MOONLIGHT_PHASE_ENABLED && TIME_MOON_PHASE_LIGHT
    float distanceToFull = float(moonPhase > 4 ? 8 - moonPhase : moonPhase) / 4.0;
#if MOONLIGHT_PHASE_RESPONSE == 0
    float response = 0.5;
#elif MOONLIGHT_PHASE_RESPONSE == 1
    float response = 1.0;
#else
    float response = 1.6;
#endif
    float factor = 1.0 - MOONLIGHT_NEW_MOON_DIMMING * distanceToFull * response;
    if (moonPhase == 0) factor += MOONLIGHT_FULL_MOON_BOOST * response * 0.5;
    return clamp(factor, 0.05, 2.0);
#else
    return 1.0;
#endif
}

void main() {
    vec4 albedo = texture2D(texture, texcoord);
    vec3 viewDir = normalize(-viewPosV);
    float viewDist = length(viewPosV);
    vec3 up = normalize(upPosition);
    float upFacing = clamp(dot(viewNormal, up), 0.0, 1.0);

    // --- Biome tint treatment (operates on the baked vertex color) -------------
    vec3 tint = vertexColor.rgb;
#if BIOMES_ENABLED
    bool tinted = abs(tint.r - tint.g) + abs(tint.g - tint.b) > 0.02;
    if (tinted) {
        tint = anvilSaturate(tint, BIOMES_SATURATION);
        tint = (tint - 0.5) * (0.75 + BIOMES_CONTRAST * 0.5) + 0.5;
        tint = anvilHueShift(tint, BIOMES_SHIFT * 1.2);
        tint = clamp(tint, 0.0, 1.0);
    }
#endif
    albedo.rgb *= tint;
    albedo.a *= vertexColor.a;

    bool isPlant = anvilIsMat(materialFlag, ANVIL_MAT_PLANT);
    bool isLeaves = anvilIsMat(materialFlag, ANVIL_MAT_LEAVES);
    bool isLava = anvilIsMat(materialFlag, ANVIL_MAT_LAVA);
    bool isOre = anvilIsMat(materialFlag, ANVIL_MAT_EMISSIVE);

    // --- Foliage color ----------------------------------------------------------
#if FOLIAGE_ENABLED
    if (isPlant || isLeaves) {
        albedo.rgb = anvilSaturate(albedo.rgb, FOLIAGE_SATURATION);
        albedo.rgb *= FOLIAGE_BRIGHTNESS;
        albedo.rgb = mix(albedo.rgb, FOLIAGE_TINT * anvilLuma(albedo.rgb) * 2.0, FOLIAGE_TINT_AMOUNT * 0.6);
    }
#endif

    // --- Surface relief (emboss from the texture's own luminance) ---------------
#if PARALLAX_ENABLED
    {
        vec2 texel = 1.0 / vec2(max(atlasSize.x, 1), max(atlasSize.y, 1));
        float here = anvilLuma(texture2D(texture, texcoord).rgb);
        float right = anvilLuma(texture2D(texture, texcoord + vec2(texel.x, 0.0)).rgb);
        float below = anvilLuma(texture2D(texture, texcoord + vec2(0.0, texel.y)).rgb);
        float grad = (here - right) + (here - below);
        float relief = grad * mix(2.2, 0.8, PARALLAX_SOFTNESS);
        float fade = 1.0 - smoothstep(8.0, 8.0 + PARALLAX_DISTANCE * 56.0, viewDist);
        albedo.rgb *= 1.0 + relief * PARALLAX_DEPTH * fade;
    }
#endif

    // --- Lightmap shaping --------------------------------------------------------
    float blockLightRaw = clamp(lmcoord.x, 0.0, 1.0);
    float skyLight = clamp(lmcoord.y, 0.0, 1.0);
    float dayWeight = anvilDayCurve(sunAngle);

    // --- Artificial (block) light -------------------------------------------------
    vec3 blockColor = vec3(0.0);
    float blockLight = 0.0;
#if BLOCK_LIGHT_ENABLED
    blockLight = pow(clamp(blockLightRaw * BLOCK_LIGHT_RADIUS, 0.0, 1.0), clamp(BLOCK_LIGHT_FALLOFF, 0.1, 8.0));

    float flicker = anvilValueNoise(vec2(frameTimeCounter * 7.0, worldPos.x + worldPos.z));
    blockLight *= 1.0 - BLOCK_LIGHT_FIRE_FLICKER * 0.25 * (flicker - 0.5) * blockLight;

    // Color mode: 0 vanilla, 1 warm, 2 per block (banded), 3 custom.
    vec3 torchTint = BLOCK_LIGHT_TORCH_TINT;
#if BLOCK_LIGHT_COLOR_MODE == 0
    vec3 lightTint = vec3(1.0, 0.9, 0.75);
#elif BLOCK_LIGHT_COLOR_MODE == 1
    vec3 lightTint = mix(vec3(1.0, 0.82, 0.6), torchTint, 0.5);
#elif BLOCK_LIGHT_COLOR_MODE == 2
    // Banded blend: faint light reads as redstone, mid as lantern, hot as torch.
    vec3 lightTint = mix(BLOCK_LIGHT_REDSTONE_TINT, BLOCK_LIGHT_LANTERN_TINT, smoothstep(0.05, 0.45, blockLight));
    lightTint = mix(lightTint, torchTint, smoothstep(0.45, 0.9, blockLight));
    // The hottest light levels (lava pools, fire) lean toward the lava tint.
    lightTint = mix(lightTint, BLOCK_LIGHT_LAVA_TINT, smoothstep(0.93, 1.0, blockLight) * 0.6);
#if ANVIL_DIM == -1
    lightTint = mix(lightTint, BLOCK_LIGHT_SOUL_TINT, 0.35);
#endif
#if ANVIL_DIM == 1
    lightTint = mix(lightTint, BLOCK_LIGHT_END_TINT, 0.45);
#endif
#else
    vec3 lightTint = torchTint;
#endif

#if !BLOCK_LIGHT_COLORED_LAMPS
    lightTint = vec3(dot(lightTint, vec3(0.3333)));
#endif

    blockColor = blockLight * BLOCK_LIGHT_INTENSITY * lightTint;
    blockColor += blockLight * blockLight * BLOCK_LIGHT_HEAT_GLOW * 0.3 * lightTint;
    blockColor *= mix(0.7, 1.3, BLOCK_LIGHT_ARTIFICIAL_BALANCE);
#if ANVIL_DIM == -1
    blockColor *= 1.0 + DIMENSIONS_NETHER_GLOW * 0.4;
#endif
#endif

    // --- Natural (sun + moon) light ------------------------------------------------
    vec3 naturalColor = vec3(0.0);
#if SUNLIGHT_ENABLED
    {
        vec3 sun = anvilSunColor();

        // Time-of-day shaping.
        float dawn = anvilDawnWeight(sunAngle);
        float sunset = anvilSunsetWeight(sunAngle);
        float lowAngle = max(dawn, sunset);
        float intensity = SUNLIGHT_INTENSITY;
        intensity *= 1.0 + dawn * SUNLIGHT_DAWN_BOOST * 0.6;
        intensity *= mix(1.0, 0.55 + SUNLIGHT_LOW_ANGLE_STRENGTH * 0.7, lowAngle);
        sun = mix(sun, sun * vec3(1.25, 0.82, 0.55), sunset * SUNLIGHT_SUNSET_WARMTH);

        // Weather response: 0 off, 1 soft, 2 balanced, 3 dramatic.
#if SUNLIGHT_WEATHER_RESPONSE == 0
        float rainDim = 0.0;
#elif SUNLIGHT_WEATHER_RESPONSE == 1
        float rainDim = 0.3;
#elif SUNLIGHT_WEATHER_RESPONSE == 2
        float rainDim = 0.55;
#else
        float rainDim = 0.8;
#endif
        intensity *= 1.0 - rainStrength * rainDim;

        // Noon crispness: contrast on the skylight curve around midday.
        float crisp = mix(1.0, pow(skyLight, 1.8), SUNLIGHT_NOON_CRISPNESS * dayWeight);

        // Time blending: 0 instant, 1 smooth, 2 cinematic.
#if SUNLIGHT_TIME_BLENDING == 0
        float blendedDay = step(0.4, dayWeight);
#elif SUNLIGHT_TIME_BLENDING == 1
        float blendedDay = dayWeight;
#else
        float blendedDay = dayWeight * dayWeight * (3.0 - 2.0 * dayWeight);
#endif

        naturalColor += skyLight * crisp * intensity * blendedDay * sun;
    }
#endif

#if MOONLIGHT_ENABLED
    {
        vec3 moon = mix(MOONLIGHT_TINT, vec3(0.5, 0.62, 1.0), MOONLIGHT_BLUE_SHIFT);
        moon = anvilSaturate(moon, clamp(1.0 + MOONLIGHT_SATURATION, 0.0, 2.0));
        float night = 1.0 - dayWeight;
        float moonStrength = MOONLIGHT_INTENSITY * anvilMoonPhaseFactor();

        // Visibility style: 0 dark, 1 natural, 2 readable, 3 bright.
#if MOONLIGHT_VISIBILITY_STYLE == 0
        moonStrength *= 0.7;
#elif MOONLIGHT_VISIBILITY_STYLE == 2
        moonStrength *= 1.3;
#elif MOONLIGHT_VISIBILITY_STYLE == 3
        moonStrength *= 1.6;
#endif

        naturalColor += skyLight * moonStrength * 0.35 * night * moon;
        // Cave leak: a touch of moonlight bleeding into unlit areas at night.
        naturalColor += MOONLIGHT_CAVE_LEAK * night * (1.0 - skyLight) * moon * 0.3;
    }
#endif

    vec3 light = blockColor + naturalColor;

#if MOONLIGHT_ENABLED
    {
        float night = 1.0 - dayWeight;
        vec3 floorLight = vec3(MOONLIGHT_AMBIENT_FLOOR * 0.5);
#if MOONLIGHT_VISIBILITY_STYLE >= 2
        floorLight *= 1.5;
#endif
        light = max(light, floorLight * mix(0.4, 1.0, night));
        light = (light - 0.5) * (0.5 + MOONLIGHT_CONTRAST) + 0.5;
        light = max(light, vec3(MOONLIGHT_MINIMUM_LUMINANCE));
    }
#endif

    albedo.rgb *= clamp(light, 0.0, 3.0);

    // --- Terrain contrast / saturation ------------------------------------------
#if TERRAIN_ENABLED
    albedo.rgb = (albedo.rgb - 0.5) * (0.75 + TERRAIN_CONTRAST * 0.5) + 0.5;
    albedo.rgb = anvilSaturate(albedo.rgb, 0.75 + TERRAIN_SATURATION * 0.5);
#endif

    // --- Translucency: leaf glow (light through foliage) --------------------------
#if TRANSLUCENCY_ENABLED
    if (isLeaves || isPlant) {
        float backlight = skyLight * dayWeight * TRANSLUCENCY_LEAF_GLOW;
        albedo.rgb += albedo.rgb * backlight * 0.45;
    }
#endif

    // --- PBR (labPBR maps when present, procedural fallback otherwise) ------------
    float gloss = 0.0;
#if PBR_ENABLED
    {
        vec4 specMap = texture2D(specular, texcoord);
        vec3 normalMap = texture2D(normals, texcoord).rgb;
        bool hasMaps = normalMap.b > 0.1 || specMap.r > 0.01;

        vec3 normal = viewNormal;
        if (hasMaps && normalMap.b > 0.1) {
            vec3 bent = normalize(normalMap * 2.0 - 1.0);
            normal = normalize(mix(viewNormal, normalize(viewNormal + bent * 0.5), PBR_NORMAL_STRENGTH));
        }

        float smoothness = hasMaps ? specMap.r : PBR_FALLBACK_SHINE * anvilLuma(albedo.rgb);
        vec3 sunDir = normalize(sunPosition);
        vec3 halfway = normalize(sunDir + viewDir);
        float spec = pow(clamp(dot(normal, halfway), 0.0, 1.0), mix(8.0, 64.0, smoothness));
        gloss = spec * smoothness * PBR_SPECULAR_STRENGTH * skyLight * dayWeight;

        // labPBR emissive lives in the specular alpha channel (1.0 = none).
        if (hasMaps && specMap.a < 0.999 && specMap.a > 0.0) {
            albedo.rgb += albedo.rgb * specMap.a * PBR_EMISSIVE_STRENGTH;
        }
    }
#endif

    // --- Wetness (rain-soaked surfaces) -------------------------------------------
    float wetAmount = 0.0;
#if WETNESS_ENABLED && WEATHER_WET_SURFACES
    {
        wetAmount = pow(clamp(wetness, 0.0, 1.0), mix(2.0, 0.6, WETNESS_RESPONSE)) * skyLight;
        float puddleMask = 0.0;
        if (upFacing > 0.8) {
            float noise = anvilFbm(worldPos.xz * 0.35, 0.5);
            puddleMask = smoothstep(1.0 - WETNESS_PUDDLES * 0.6, 1.0, noise + wetAmount * 0.35) * wetAmount;
        }
        albedo.rgb *= 1.0 - WETNESS_DARKENING * 0.45 * wetAmount * (1.0 + puddleMask);

        vec3 sunDir = normalize(sunPosition);
        vec3 halfway = normalize(sunDir + viewDir);
        float wetSpec = pow(clamp(dot(viewNormal, halfway), 0.0, 1.0), 32.0);
        float puddleGloss = puddleMask * (1.0 + WEATHER_PUDDLE_REFLECTIONS * 2.0);
        gloss += wetSpec * WETNESS_GLOSS * (wetAmount * 0.6 + puddleGloss) * dayWeight;

#if WEATHER_RAIN_SPLASH
        // Sparkle while rain is actively falling.
        float sparkle = step(0.985, anvilHash(floor(worldPos.xz * 6.0) + floor(frameTimeCounter * 8.0)));
        albedo.rgb += sparkle * rainStrength * wetAmount * 0.25;
#endif
    }
#endif

    albedo.rgb += gloss * anvilSunColor();

    // --- Emissive surfaces ----------------------------------------------------------
    float emissive = 0.0;
#if EMISSIVE_LIGHT_ENABLED && EMISSIVE_LIGHT_SOURCE_MODE != 0
    {
        float animation = 1.0;
#if EMISSIVE_LIGHT_ANIMATION_STYLE == 0
        float animScale = 0.0;
#elif EMISSIVE_LIGHT_ANIMATION_STYLE == 1
        float animScale = 0.5;
#elif EMISSIVE_LIGHT_ANIMATION_STYLE == 2
        float animScale = 1.0;
#else
        float animScale = 1.8;
#endif
#if EMISSIVE_LIGHT_PULSE_ENABLED
        animation += sin(frameTimeCounter * (0.8 + EMISSIVE_LIGHT_PULSE_SPEED * 4.0)) * EMISSIVE_LIGHT_PULSE_DEPTH * animScale;
#endif
        animation += (anvilValueNoise(vec2(frameTimeCounter * 9.0, worldPos.x - worldPos.z)) - 0.5) * EMISSIVE_LIGHT_FLICKER * animScale;

        if (isOre) {
            emissive = EMISSIVE_LIGHT_ORE_GLOW;
        }
        if (isPlant || isLeaves) {
            emissive = max(emissive, EMISSIVE_LIGHT_PLANT_GLOW * smoothstep(0.6, 1.0, anvilLuma(albedo.rgb)));
        }
#if EMISSIVE_LIGHT_SOURCE_MODE == 3
        // Auto detect: bright pixels on strongly block-lit surfaces glow.
        emissive = max(emissive, smoothstep(0.75, 0.95, anvilLuma(albedo.rgb)) * blockLightRaw * 0.6);
#endif
        emissive *= EMISSIVE_LIGHT_STRENGTH * max(animation, 0.0);
        albedo.rgb += albedo.rgb * emissive * EMISSIVE_LIGHT_CUSTOM_TINT * 1.5;
    }
#endif

    // --- Lava -------------------------------------------------------------------------
#if LAVA_ENABLED
    if (isLava) {
        float crust = anvilLuma(albedo.rgb);
        albedo.rgb = mix(albedo.rgb, albedo.rgb * albedo.rgb * 2.2, LAVA_CONTRAST);
        float pulse = 1.0 + sin(frameTimeCounter * 1.7 + worldPos.x * 0.4 + worldPos.z * 0.3) * LAVA_PULSE * 0.4;
        albedo.rgb += LAVA_TINT * crust * LAVA_GLOW * pulse;
        emissive = max(emissive, clamp(LAVA_GLOW * crust, 0.0, 1.0));
    }
#endif

    gl_FragData[0] = albedo;
    gl_FragData[1] = vec4(materialFlag, skyLight, blockLightRaw, emissive);
}
