// Translucents: water tint/clarity/detail, sky reflections, glass clarity and
// tint, ice shine, and the nether portal shimmer.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D texture;
uniform vec3 sunPosition;
uniform float sunAngle;
uniform float frameTimeCounter;

varying vec2 texcoord;
varying vec2 lmcoord;
varying vec4 vertexColor;
varying vec3 viewNormal;
varying vec3 viewPosV;
varying vec3 worldPos;
varying float materialFlag;

void main() {
    vec4 albedo = texture2D(texture, texcoord) * vertexColor;
    vec3 viewDir = normalize(-viewPosV);
    float skyLight = clamp(lmcoord.y, 0.0, 1.0);
    float blockLight = clamp(lmcoord.x, 0.0, 1.0);
    float dayWeight = anvilDayCurve(sunAngle);
    float emissive = 0.0;

    bool isWater = anvilIsMat(materialFlag, ANVIL_MAT_WATER);
    bool isPortal = anvilIsMat(materialFlag, ANVIL_MAT_PORTAL);
    bool isIce = anvilIsMat(materialFlag, ANVIL_MAT_ICE);
    bool isGlass = anvilIsMat(materialFlag, ANVIL_MAT_GLASS);

    // Simple translucent lighting so the surface still reads day/night.
    float light = 0.25 + 0.75 * max(skyLight * mix(0.35, 1.0, dayWeight), blockLight);

    // --- Water ---------------------------------------------------------------------
#if WATER_ENABLED
    if (isWater) {
        // Tint toward the configured color, scaled by tint strength.
        vec3 tinted = mix(albedo.rgb, WATER_TINT * anvilLuma(albedo.rgb) * 2.5, WATER_TINT_STRENGTH);
        tinted *= ANVIL_WATER_TINT / max(vec3(0.18, 0.44, 0.56), vec3(0.001)); // legacy quick tint (neutral at default)
        albedo.rgb = tinted;

        // Clarity: more transparent surface.
        albedo.a *= mix(1.0, 0.45, WATER_CLARITY);

        // Surface detail: micro contrast from a procedural ripple pattern.
        float freq = mix(2.0, 0.45, WATER_WAVE_SCALE) * 3.0;
        float speed = frameTimeCounter * (0.5 + WATER_WAVE_SPEED * 2.5);
        float ripple = anvilValueNoise(worldPos.xz * freq + vec2(speed * 0.7, speed * 0.4));
        albedo.rgb *= 1.0 + (ripple - 0.5) * WATER_DETAIL * 0.5;

        // Procedural wave normal for fresnel-weighted sky reflection.
#if REFLECTIONS_ENABLED
        float r1 = anvilValueNoise(worldPos.xz * freq + vec2(speed * 0.7, speed * 0.4));
        float r2 = anvilValueNoise(worldPos.xz * freq + vec2(speed * 0.7 + 3.1, speed * 0.4));
        float r3 = anvilValueNoise(worldPos.xz * freq + vec2(speed * 0.7, speed * 0.4 + 3.1));
        vec3 normal = normalize(viewNormal + vec3(r2 - r1, 0.0, r3 - r1) * REFLECTIONS_ROUGHNESS * 0.8);

        float fresnel = pow(1.0 - clamp(dot(viewDir, normal), 0.0, 1.0), mix(5.0, 1.5, REFLECTIONS_FRESNEL));

        // Sky-color reflection (modes: 0 sky only, 1 screen space, 2 hybrid).
        // Screen-space marching happens in the deferred pass; this is the sky base.
#if REFLECTIONS_MODE != 1
        vec3 skyReflect = mix(SKY_HORIZON_COLOR, SKY_ZENITH_COLOR, 0.55) * REFLECTIONS_SKY_TINT;
        skyReflect *= mix(0.08, 1.0, dayWeight) * skyLight;
        albedo.rgb += skyReflect * fresnel * REFLECTIONS_STRENGTH;
        albedo.a = clamp(albedo.a + fresnel * REFLECTIONS_STRENGTH * 0.35, 0.0, 1.0);
#endif

        // Sun glitter on the waves.
        vec3 halfway = normalize(normalize(sunPosition) + viewDir);
        float glitter = pow(clamp(dot(normal, halfway), 0.0, 1.0), 48.0);
        albedo.rgb += glitter * REFLECTIONS_STRENGTH * dayWeight * skyLight * vec3(1.0, 0.95, 0.85);
#endif
    }
#endif

    // --- Stained glass / generic translucents ----------------------------------------
#if TRANSLUCENCY_ENABLED
    if (isGlass) {
        albedo.a *= mix(1.0, 0.55, TRANSLUCENCY_GLASS_CLARITY);
        albedo.rgb = anvilSaturate(albedo.rgb, 0.6 + TRANSLUCENCY_GLASS_TINT * 0.8);
    }
    if (isIce) {
        vec3 halfway = normalize(normalize(sunPosition) + viewDir);
        float sparkle = pow(clamp(dot(viewNormal, halfway), 0.0, 1.0), 24.0);
        sparkle += step(0.97, anvilHash(floor(worldPos.xz * 4.0) + floor(worldPos.y))) * 0.6;
        albedo.rgb += sparkle * TRANSLUCENCY_ICE_SHINE * dayWeight * skyLight;
    }
#endif

    // --- Nether portal shimmer ----------------------------------------------------------
#if PORTALS_ENABLED
    if (isPortal) {
        float t = frameTimeCounter * (0.5 + PORTALS_SPEED * 3.0);
        vec2 swirlUv = worldPos.xy + worldPos.zz;
        float swirl = anvilValueNoise(swirlUv * 2.0 + vec2(sin(t * 0.7), cos(t * 0.6)) * 2.0);
        swirl += anvilValueNoise(swirlUv * 4.5 - vec2(t * 0.8, t * 0.5)) * 0.5;
        albedo.rgb = mix(albedo.rgb, PORTALS_TINT * (0.6 + swirl), PORTALS_SHIMMER * 0.6);
        albedo.rgb += PORTALS_TINT * swirl * PORTALS_GLOW * 0.8;
        emissive = clamp(PORTALS_GLOW * (0.5 + swirl * 0.5), 0.0, 1.0);
        light = max(light, 0.9);
    }
#endif

    albedo.rgb *= light;

    gl_FragData[0] = albedo;
    gl_FragData[1] = vec4(materialFlag, skyLight, blockLight, emissive);
}
