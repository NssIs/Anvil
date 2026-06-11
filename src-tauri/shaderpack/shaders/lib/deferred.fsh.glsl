// Deferred main pass body — included by composite1.fsh (per dimension).
// Applies shadows, ambient occlusion, bounce light, water refraction and
// reflections, procedural sky (clouds, stars, aurora), fog, weather moods,
// time-of-day grading and dimension atmospheres.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D colortex0;
uniform sampler2D colortex2;
uniform sampler2D colortex3;
uniform sampler2D depthtex0;
uniform sampler2D depthtex1;
uniform sampler2D shadowtex0;
uniform mat4 gbufferProjection;
uniform mat4 gbufferProjectionInverse;
uniform mat4 gbufferModelView;
uniform mat4 gbufferModelViewInverse;
uniform mat4 shadowModelView;
uniform mat4 shadowProjection;
uniform vec3 cameraPosition;
uniform vec3 sunPosition;
uniform vec3 moonPosition;
uniform vec3 shadowLightPosition;
uniform vec3 upPosition;
uniform vec3 fogColor;
uniform float sunAngle;
uniform float rainStrength;
uniform float thunderStrength;  // Iris uniform; reads 0 on loaders without it
uniform float temperature;      // Iris biome uniform; reads 0 when absent
uniform float frameTimeCounter;
uniform float far;
uniform float viewWidth;
uniform float viewHeight;
uniform int moonPhase;
uniform int heldBlockLightValue;

varying vec2 texcoord;

vec3 projDivide(mat4 m, vec3 p) {
    vec4 h = m * vec4(p, 1.0);
    return h.xyz / h.w;
}

vec3 viewPosAt(vec2 uv, float depth) {
    return projDivide(gbufferProjectionInverse, vec3(uv, depth) * 2.0 - 1.0);
}

// ---- Shadow sampling ------------------------------------------------------------

#if ANVIL_DIM == 0 && SHADOWS_ENABLED
float shadowTap(vec2 uv, float comparedDepth) {
#if SHADOWS_TEXEL_SNAP
    uv = (floor(uv * float(shadowMapResolution)) + 0.5) / float(shadowMapResolution);
#endif
    return step(comparedDepth, texture2D(shadowtex0, uv).r);
}

float shadowVisibility(vec3 playerPos, vec3 worldNormal, float skyLight) {
    // Normal bias pushes the sample point off the surface to fight acne.
    playerPos += worldNormal * SHADOWS_NORMAL_BIAS * 0.35;

    vec3 shadowView = (shadowModelView * vec4(playerPos, 1.0)).xyz;
    vec3 shadowClip = projDivide(shadowProjection, shadowView);
    float distortFactor = length(shadowClip.xy) * SHADOWS_DISTORTION + (1.0 - SHADOWS_DISTORTION);
    shadowClip.xy = anvilDistortShadow(shadowClip.xy);
    vec3 shadowPos = shadowClip * 0.5 + 0.5;

    if (shadowPos.x < 0.0 || shadowPos.x > 1.0 || shadowPos.y < 0.0 || shadowPos.y > 1.0) {
        return 1.0;
    }

    float bias = SHADOWS_BIAS * 0.02 * distortFactor / max(SHADOWS_DISTORTION, 0.05);
    float compared = shadowPos.z - bias;

#if PERFORMANCE_SINGLE_TAP_SHADOWS
    float lit = shadowTap(shadowPos.xy, compared);
#elif SHADOWS_FILTER == 0
    float lit = shadowTap(shadowPos.xy, compared);
#else
    float texel = 1.0 / float(shadowMapResolution);
    float radius = texel * (0.5 + SHADOWS_SOFTNESS * 2.5) * distortFactor;

#if SHADOWS_FILTER == 3
    // Variable penumbra: a small blocker search widens the filter where the
    // occluder is far above the surface.
    float blockerSum = 0.0;
    for (int i = 0; i < 4; i++) {
        vec2 offset = vec2(float(i / 2) - 0.5, float(i - (i / 2) * 2) - 0.5) * texel * 3.0;
        float blockerDepth = texture2D(shadowtex0, shadowPos.xy + offset).r;
        blockerSum += clamp((shadowPos.z - blockerDepth) * 40.0, 0.0, 1.0);
    }
    radius *= 1.0 + blockerSum;
#endif

#if SHADOWS_FILTER == 1
    const int taps = 4;
#else
    const int taps = 9;
#endif
    float lit = 0.0;
    for (int i = 0; i < taps; i++) {
        float angle = float(i) * 2.39996;
        float rad = radius * sqrt((float(i) + 0.5) / float(taps));
        lit += shadowTap(shadowPos.xy + vec2(cos(angle), sin(angle)) * rad, compared);
    }
    lit /= float(taps);
#endif

    // Light-leak reduction: dark interiors cannot be sun-lit.
    lit = min(lit, mix(1.0, smoothstep(0.05, 0.5, skyLight), SHADOWS_LEAK_FIX));
    return lit;
}

// Short screen-space ray toward the light for contact shadows.
float contactShadow(vec3 viewPos) {
#if SHADOWS_CONTACT_ENABLED
    vec3 lightDir = normalize(shadowLightPosition);
    const int steps = 8;
    float stepLen = SHADOWS_CONTACT_LENGTH * 0.25 / float(steps);
    vec3 ray = viewPos;
    for (int i = 1; i <= steps; i++) {
        ray += lightDir * stepLen * float(i);
        vec3 clip = projDivide(gbufferProjection, ray);
        vec2 uv = clip.xy * 0.5 + 0.5;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
        float sampleDepth = texture2D(depthtex1, uv).r;
        vec3 samplePos = viewPosAt(uv, sampleDepth);
        float diff = ray.z - samplePos.z;
        if (diff < -0.02 && diff > -0.35) {
            return 1.0 - SHADOWS_CONTACT_OPACITY;
        }
    }
#endif
    return 1.0;
}
#endif

// ---- Procedural sky: clouds -------------------------------------------------------

float cloudNoise(vec2 pos) {
#if PERFORMANCE_SIMPLE_CLOUDS
    return anvilValueNoise(pos);
#else
    return anvilFbm(pos, CLOUDS_TURBULENCE);
#endif
}

float cloudCoverageAt(vec2 planePos, float timeSeconds) {
    float rad = radians(CLOUDS_DIRECTION);
    vec2 wind = vec2(cos(rad), sin(rad)) * timeSeconds * (0.4 + CLOUDS_SPEED * 4.0);
    float noise = cloudNoise(planePos * 0.004 + wind * 0.004);
    float density = CLOUDS_DENSITY;
#if CLOUDS_WEATHER_SYNC
    density = clamp(density + rainStrength * 0.35, 0.0, 1.0);
#endif
    return smoothstep(1.0 - density, 1.0 - density + 0.35, noise);
}

vec3 applyClouds(vec3 sky, vec3 worldDir, float dayWeight) {
#if CLOUDS_STYLE == 0
    return sky; // vanilla geometry clouds handle this style
#else
    if (worldDir.y < 0.02) return sky;

    float altitude = 96.0 + CLOUDS_HEIGHT * 140.0;
    float planeDist = (altitude - cameraPosition.y) / worldDir.y;
    if (planeDist < 0.0) return sky;
    vec2 planePos = cameraPosition.xz + worldDir.xz * planeDist;

    float coverage = cloudCoverageAt(planePos, frameTimeCounter);
    if (coverage <= 0.001) return sky;

    // Layer depth: a second sample above shades the underside.
    float upper = cloudCoverageAt(planePos + worldDir.xz * 24.0, frameTimeCounter + 6.0);
    float shade = 1.0 - upper * CLOUDS_SHADOWING * CLOUDS_DEPTH;

    vec3 sunDir = normalize(mat3(gbufferModelViewInverse) * sunPosition);
    float sunDot = clamp(dot(worldDir, sunDir), 0.0, 1.0);

    vec3 cloudColor = vec3(1.0) * mix(0.35, 1.0, dayWeight) * shade;
    cloudColor += vec3(1.0, 0.9, 0.75) * CLOUDS_SUN_SCATTER * pow(sunDot, 3.0) * dayWeight * 0.6;
    cloudColor = mix(CLOUDS_NIGHT_TINT, cloudColor, dayWeight);

#if CLOUDS_SILVER_LINING
    float edge = coverage * (1.0 - coverage) * 4.0;
    cloudColor += vec3(1.0, 0.95, 0.85) * edge * pow(sunDot, 6.0) * dayWeight * 0.8;
#endif

    // Style shaping: 1 painted (soft), 2 volumetric soft, 3 storm shelf.
#if CLOUDS_STYLE == 1
    float alpha = coverage * 0.7;
#elif CLOUDS_STYLE == 2
    float alpha = coverage * coverage * (3.0 - 2.0 * coverage) * 0.85;
#else
    float alpha = smoothstep(0.1, 0.6, coverage);
    cloudColor *= 0.65;
#endif

    // Fade clouds toward the horizon.
    alpha *= smoothstep(0.02, 0.18, worldDir.y);
    return mix(sky, cloudColor, clamp(alpha, 0.0, 1.0));
#endif
}

// ---- Procedural sky: stars ----------------------------------------------------------

vec3 applyStars(vec3 sky, vec3 worldDir, float nightWeight) {
    if (worldDir.y < 0.0 || nightWeight < 0.01) return sky;

    // Night clarity: 0 hazy, 1 clear, 2 crisp, 3 deep space.
#if STARS_NIGHT_CLARITY == 0
    float clarity = 0.6;
#elif STARS_NIGHT_CLARITY == 1
    float clarity = 1.0;
#elif STARS_NIGHT_CLARITY == 2
    float clarity = 1.35;
#else
    float clarity = 1.8;
#endif

    vec2 sphereUv = worldDir.xz / (worldDir.y + 0.6);
    float cellScale = mix(60.0, 26.0, STARS_SIZE);
    vec2 cell = floor(sphereUv * cellScale);
    vec2 cellUv = fract(sphereUv * cellScale);

    float present = step(1.0 - STARS_DENSITY * 0.35, anvilHash(cell));
    vec2 starPos = vec2(anvilHash(cell + 11.7), anvilHash(cell + 31.3)) * 0.6 + 0.2;
    float distToStar = length(cellUv - starPos);
    float core = 1.0 - smoothstep(0.0, 0.08 + STARS_SIZE * 0.1, distToStar);

    float twinkle = 1.0 - STARS_TWINKLE * 0.6 * (0.5 + 0.5 * sin(frameTimeCounter * 3.0 + anvilHash(cell) * 40.0));
    vec3 starTint = mix(vec3(1.0), vec3(0.7 + anvilHash(cell + 5.0) * 0.6, 0.8, 0.7 + anvilHash(cell + 9.0) * 0.6), STARS_COLOR_VARIATION);

    float strength = present * core * STARS_BRIGHTNESS * twinkle * clarity;

#if STARS_CONSTELLATION_HINTS
    // Low-frequency clusters get a brightness lift, hinting at constellations.
    float cluster = step(0.75, anvilValueNoise(cell * 0.12));
    strength *= 1.0 + cluster * 1.2;
#endif

    vec3 result = sky + starTint * strength * nightWeight * smoothstep(0.0, 0.2, worldDir.y);

#if STARS_MILKY_BAND
    // A tilted band of faint fbm glow across the sky.
    vec3 bandNormal = normalize(vec3(0.35, 0.45, 0.82));
    float band = 1.0 - smoothstep(0.0, 0.35, abs(dot(worldDir, bandNormal)));
    float bandNoise = anvilFbm(sphereUv * 4.0, 0.5);
    result += STARS_MILKY_COLOR * band * bandNoise * STARS_MILKY_OPACITY * nightWeight * clarity * 0.6;
#endif

#if STARS_SHOOTING_STARS
    // Time-windowed streaks: each ~4s window may spawn one meteor.
    float window = floor(frameTimeCounter * 0.25);
    if (anvilHash(vec2(window, 3.7)) < STARS_SHOOTING_FREQUENCY) {
        float progress = fract(frameTimeCounter * 0.25);
        vec2 start = vec2(anvilHash(vec2(window, 1.1)), anvilHash(vec2(window, 2.2))) * 2.0 - 1.0;
        vec2 dir = normalize(vec2(anvilHash(vec2(window, 4.4)) - 0.5, anvilHash(vec2(window, 5.5)) - 0.5) + 0.001);
        vec2 head = start + dir * progress * 1.6;
        vec2 toHead = sphereUv - head;
        float along = dot(toHead, -dir);
        float side = abs(dot(toHead, vec2(-dir.y, dir.x)));
        float streak = (1.0 - smoothstep(0.0, 0.25, along)) * step(0.0, along) * (1.0 - smoothstep(0.0, 0.012, side));
        result += vec3(1.0, 0.97, 0.9) * streak * nightWeight * (1.0 - progress) * 2.0;
    }
#endif

    return result;
}

// ---- Procedural sky: aurora -----------------------------------------------------------

vec3 applyAurora(vec3 sky, vec3 worldDir, float nightWeight) {
#if AURORA_ENABLED
    if (worldDir.y < 0.05 || nightWeight < 0.01) return sky;

#if AURORA_WEATHER_FILTER
    if (rainStrength > 0.4) return sky;
#endif

    // Biome rule: 0 all nights, 1 cold biomes, 2 high altitude, 3 End only.
#if AURORA_BIOME_RULE == 1
    if (temperature > 0.35) return sky;
#elif AURORA_BIOME_RULE == 2
    if (cameraPosition.y < 100.0) return sky;
#elif AURORA_BIOME_RULE == 3
#if ANVIL_DIM != 1
    return sky;
#endif
#endif

    // Frequency: not every night has an aurora — gate per moon phase.
    if (anvilHash(vec2(float(moonPhase), 13.7)) > AURORA_FREQUENCY + 0.05) return sky;

    const int bandCount = int(AURORA_BAND_COUNT);
    vec3 aurora = vec3(0.0);
    float t = frameTimeCounter * (0.1 + AURORA_WAVE_SPEED * 0.7);

    for (int i = 0; i < bandCount; i++) {
        float fi = float(i);
        float bandHeight = 0.25 + AURORA_CURTAIN_HEIGHT * 0.55 + fi * 0.07;
        float wave = sin(worldDir.x * (3.0 + fi) / max(worldDir.y, 0.1) + t * (1.0 + fi * 0.3));
        wave += anvilFbm(vec2(worldDir.x / max(worldDir.y, 0.1) * 2.0, t * 0.5 + fi * 7.0), 0.5) - 0.5;
        float center = bandHeight + wave * 0.08;
        float distToBand = abs(worldDir.y - center);

#if AURORA_SOFT_EDGES
        float band = 1.0 - smoothstep(0.0, 0.12, distToBand);
#else
        float band = 1.0 - smoothstep(0.0, 0.05, distToBand);
#endif

        float colorPhase = fract(fi * 0.37 + AURORA_COLOR_SHIFT * sin(t * 0.4 + fi));
        vec3 bandColor = mix(AURORA_PRIMARY_COLOR, AURORA_SECONDARY_COLOR, colorPhase);
        aurora += bandColor * band / float(bandCount);
    }

    return sky + aurora * AURORA_INTENSITY * nightWeight * 1.4;
#else
    return sky;
#endif
}

// ---- Main -------------------------------------------------------------------------------

void main() {
    float depth = texture2D(depthtex0, texcoord).r;
    vec2 sampleUv = texcoord;
    vec4 materials = texture2D(colortex3, texcoord);
    bool isWater = anvilIsMat(materials.r, ANVIL_MAT_WATER);
    float skyLight = materials.g;
    float blockLight = materials.b;

    float dayWeight = anvilDayCurve(sunAngle);
    float nightWeight = 1.0 - dayWeight;
    vec2 texel = 1.0 / vec2(viewWidth, viewHeight);

    vec3 viewPos = viewPosAt(texcoord, depth);
    vec3 playerPos = (gbufferModelViewInverse * vec4(viewPos, 1.0)).xyz;
    vec3 worldDir = normalize(playerPos);
    float dist01 = clamp(length(viewPos) / max(far, 1.0), 0.0, 1.0);

    // --- Water refraction: bend the scene sampled through water ---------------------
#if REFRACTION_ENABLED
    if (isWater && depth < 1.0) {
        float behindDepth = texture2D(depthtex1, texcoord).r;
        float depthGap = clamp((behindDepth - depth) * 220.0, 0.0, 1.0);
        float fade = mix(1.0, depthGap, REFRACTION_DEPTH_FADE);

        vec3 wpos = playerPos + cameraPosition;
        float speed = frameTimeCounter * (0.5 + WATER_WAVE_SPEED * 2.5);
        float n1 = anvilValueNoise(wpos.xz * 1.5 + speed * 0.5);
        float n2 = anvilValueNoise(wpos.xz * 1.5 + 3.7 - speed * 0.4);
        vec2 wobble = (vec2(n1, n2) - 0.5) * mix(0.4, 1.0, REFRACTION_WAVE_INFLUENCE);
        sampleUv = texcoord + wobble * REFRACTION_STRENGTH * 0.03 * fade;
    }
#endif

    vec3 scene;
#if REFRACTION_ENABLED
    if (isWater && REFRACTION_DISPERSION > 0.001) {
        vec2 spread = (sampleUv - texcoord) * REFRACTION_DISPERSION;
        scene.r = texture2D(colortex0, sampleUv + spread).r;
        scene.g = texture2D(colortex0, sampleUv).g;
        scene.b = texture2D(colortex0, sampleUv - spread).b;
    } else {
        scene = texture2D(colortex0, sampleUv).rgb;
    }
#else
    scene = texture2D(colortex0, sampleUv).rgb;
#endif

    if (depth >= 1.0) {
        // ---- Sky pixels ------------------------------------------------------------
#if ANVIL_DIM == 0
        scene = applyStars(scene, worldDir, nightWeight);
        scene = applyAurora(scene, worldDir, nightWeight);
        scene = applyClouds(scene, worldDir, dayWeight);
#elif ANVIL_DIM == 1
        scene = mix(scene, DIMENSIONS_END_VOID_TINT, 0.45);
#if DIMENSIONS_END_STARFIELD
        scene = applyStars(scene, worldDir, 1.0);
#endif
#if AURORA_BIOME_RULE == 3
        scene = applyAurora(scene, worldDir, 1.0);
#endif
#endif
    } else {
        // ---- Lit geometry ----------------------------------------------------------

        // Screen-space reflections on water.
#if REFLECTIONS_ENABLED && REFLECTIONS_MODE != 0 && !PERFORMANCE_FAST_WATER
        if (isWater) {
#if REFLECTIONS_QUALITY == 0
            const int ssrSteps = 8;
#elif REFLECTIONS_QUALITY == 1
            const int ssrSteps = 16;
#elif REFLECTIONS_QUALITY == 2
            const int ssrSteps = 24;
#else
            const int ssrSteps = 32;
#endif
            vec3 normal = normalize(mat3(gbufferModelView) * vec3(0.0, 1.0, 0.0));
            vec3 rayDir = reflect(normalize(viewPos), normal);
            float rayLen = REFLECTIONS_DISTANCE * far * 0.4 / float(ssrSteps);
            vec3 ray = viewPos;
            vec3 hitColor = vec3(0.0);
            float hit = 0.0;
            for (int i = 1; i <= ssrSteps; i++) {
                ray += rayDir * rayLen * (1.0 + float(i) * 0.15);
                vec3 clip = projDivide(gbufferProjection, ray);
                vec2 uv = clip.xy * 0.5 + 0.5;
                if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
                float sampleDepth = texture2D(depthtex0, uv).r;
                if (sampleDepth >= 1.0) continue;
                vec3 samplePos = viewPosAt(uv, sampleDepth);
                if (ray.z < samplePos.z - 0.05 && ray.z > samplePos.z - 2.5) {
                    hitColor = texture2D(colortex0, uv).rgb;
                    hit = 1.0;
                    break;
                }
            }
            float fresnel = pow(1.0 - clamp(dot(normalize(-viewPos), normal), 0.0, 1.0), mix(5.0, 1.5, REFLECTIONS_FRESNEL));
            scene = mix(scene, hitColor, hit * fresnel * REFLECTIONS_STRENGTH * (1.0 - REFLECTIONS_ROUGHNESS * 0.5));
        }
#endif

        // Shadows (overworld only — no celestial light source elsewhere).
#if ANVIL_DIM == 0 && SHADOWS_ENABLED
        {
            vec3 worldNormal = vec3(0.0, 1.0, 0.0);
            float lit = shadowVisibility(playerPos, worldNormal, skyLight);
            lit *= contactShadow(viewPos);

            // Fade at the shadow distance edge.
            float fadeStart = shadowDistance * (1.0 - SHADOWS_FADE);
            float fade = smoothstep(fadeStart, shadowDistance, length(playerPos));
            lit = mix(lit, 1.0, fade);

            // Only sun-lit (sky-exposed) surfaces during the day are shadowed.
            float shadowInfluence = skyLight * dayWeight * (1.0 - rainStrength * 0.7);
            float darkness = mix(1.0, mix(0.35, 0.75, SHADOWS_SOFTNESS * 0.3), shadowInfluence * (1.0 - lit));
            scene *= darkness;
        }
#endif

        // Ambient occlusion + bounce light (denoised from colortex2).
#if !PERFORMANCE_FAST_LIGHTING
        {
            // Depth-aware cross blur — separate denoise radii for AO and GI.
            vec4 aoGi = texture2D(colortex2, texcoord);
            float aoRadius = AMBIENT_OCCLUSION_DENOISE * 3.0;
            float giRadius = GLOBAL_ILLUMINATION_DENOISE * 4.0;
            float aoTotal = 1.0;
            float giTotal = 1.0;
            float aoSum = aoGi.a;
            vec3 giSum = aoGi.rgb;
            for (int i = 0; i < 4; i++) {
                vec2 dir = vec2(float(i == 0) - float(i == 1), float(i == 2) - float(i == 3));
                float sampleDepthAo = texture2D(depthtex0, texcoord + dir * texel * aoRadius).r;
                float weightAo = 1.0 / (1.0 + abs(sampleDepthAo - depth) * 800.0 * AMBIENT_OCCLUSION_EDGE_PRESERVE * 8.0);
                aoSum += texture2D(colortex2, texcoord + dir * texel * aoRadius).a * weightAo;
                aoTotal += weightAo;

                float sampleDepthGi = texture2D(depthtex0, texcoord + dir * texel * giRadius).r;
                float weightGi = 1.0 / (1.0 + abs(sampleDepthGi - depth) * 600.0);
                giSum += texture2D(colortex2, texcoord + dir * texel * giRadius).rgb * weightGi;
                giTotal += weightGi;
            }
            aoGi = vec4(giSum / giTotal, aoSum / aoTotal);

#if AMBIENT_OCCLUSION_ENABLED
            float ao = pow(clamp(aoGi.a, 0.0, 1.0), AMBIENT_OCCLUSION_POWER);
            float strength = AMBIENT_OCCLUSION_STRENGTH;

            // Material bias: 0 soft, 1 balanced, 2 strong, 3 per material.
#if AMBIENT_OCCLUSION_MATERIAL_BIAS == 0
            strength *= 0.7;
#elif AMBIENT_OCCLUSION_MATERIAL_BIAS == 2
            strength *= 1.3;
#elif AMBIENT_OCCLUSION_MATERIAL_BIAS == 3
            if (anvilIsMat(materials.r, ANVIL_MAT_ENTITY)) strength *= 0.8;
            if (anvilIsMat(materials.r, ANVIL_MAT_LAVA)) strength *= 0.2;
#endif
            // Grass damping keeps foliage from going muddy.
            if (anvilIsMat(materials.r, ANVIL_MAT_PLANT) || anvilIsMat(materials.r, ANVIL_MAT_LEAVES)) {
                strength *= 1.0 - AMBIENT_OCCLUSION_GRASS_DAMPING;
            }
            // Caves get more occlusion, open sky less.
            strength *= 1.0 + AMBIENT_OCCLUSION_CAVE_BOOST * (1.0 - skyLight);
            strength *= 1.0 - AMBIENT_OCCLUSION_SKY_FADE * skyLight;

            scene *= mix(1.0, ao, clamp(strength, 0.0, 2.0));
#endif

#if GLOBAL_ILLUMINATION_ENABLED && GLOBAL_ILLUMINATION_METHOD != 0
            vec3 gi = aoGi.rgb * GLOBAL_ILLUMINATION_STRENGTH;
            gi *= mix(1.0, skyLight, GLOBAL_ILLUMINATION_SKY_BOUNCE * 0.7);
            gi += gi * blockLight * GLOBAL_ILLUMINATION_BLOCK_BOUNCE;

            // Leak reduction: dark interiors should not receive sky-driven bounce.
            gi *= mix(1.0, smoothstep(0.0, 0.4, skyLight), GLOBAL_ILLUMINATION_LEAK_REDUCTION * 0.8);

            // Indoor response: 0 dark, 1 balanced, 2 readable, 3 bright.
#if GLOBAL_ILLUMINATION_INDOOR_MODE == 0
            float indoor = 0.6;
#elif GLOBAL_ILLUMINATION_INDOOR_MODE == 1
            float indoor = 1.0;
#elif GLOBAL_ILLUMINATION_INDOOR_MODE == 2
            float indoor = 1.35;
#else
            float indoor = 1.7;
#endif
            gi *= mix(indoor, 1.0, skyLight);

            // Cave fill: a faint neutral lift deep underground.
            vec3 caveFill = vec3(0.05, 0.055, 0.07) * GLOBAL_ILLUMINATION_CAVE_FILL * (1.0 - skyLight) * indoor;

            scene += gi * 0.35 + caveFill;
#endif
        }
#endif

        // Held-light: torches in hand light the nearby world.
#if HANDHELD_ENABLED
        if (heldBlockLightValue > 0) {
            float held = float(heldBlockLightValue) / 15.0;
            float reach = 6.0 + HANDHELD_LIGHT_DISTANCE * 14.0;
            float falloff = clamp(1.0 - length(viewPos) / reach, 0.0, 1.0);
            scene += scene * falloff * falloff * held * HANDHELD_LIGHT_STRENGTH * HANDHELD_LIGHT_TINT;
        }
#endif

        // Cave atmosphere: deep, sky-less areas get a cool moody grade.
        {
            float cave = (1.0 - skyLight) * DIMENSIONS_CAVE_ATMOSPHERE;
            scene = mix(scene, scene * vec3(0.82, 0.88, 1.05), cave * 0.6);
        }

        // Aerial perspective: distant terrain desaturates.
        scene = anvilSaturate(scene, 1.0 - dist01 * TERRAIN_DISTANCE_DESAT);

        // --- Fog --------------------------------------------------------------------
#if FOG_MODE != 0
        {
            float d = clamp((dist01 - FOG_START) / max(1.0 - FOG_START, 0.01), 0.0, 1.0);
            float density = FOG_DENSITY * (0.4 + ANVIL_FOG * 1.7);

            // Overworld profile: 0 vanilla plus, 1 balanced, 2 cinematic, 3 realistic.
#if DIMENSIONS_OVERWORLD_PROFILE == 0
            density *= 0.7;
#elif DIMENSIONS_OVERWORLD_PROFILE == 2
            density *= 1.35;
#elif DIMENSIONS_OVERWORLD_PROFILE == 3
            density *= 1.1;
#endif
            float amount = 1.0 - exp(-pow(d, clamp(FOG_FALLOFF, 0.1, 3.0)) * density * 9.0);
#if FOG_MODE == 3
            amount = clamp(amount * 1.35, 0.0, 1.0); // cinematic is thicker
#endif

            vec3 fogCol = mix(FOG_NIGHT_COLOR, FOG_DAY_COLOR, dayWeight);
#if FOG_SKY_COLOR_LOCK
            fogCol = mix(fogCol, fogColor, 0.6);
#endif
            fogCol = mix(fogCol, fogColor, FOG_BIOME_TINT);

#if ANVIL_DIM == -1
            fogCol = DIMENSIONS_NETHER_COLOR;
            amount = clamp(amount + dist01 * DIMENSIONS_NETHER_HAZE * 0.5, 0.0, 1.0);
#elif ANVIL_DIM == 1
            fogCol = mix(fogCol, DIMENSIONS_END_VOID_TINT, 0.7);
            amount = clamp(amount + dist01 * DIMENSIONS_END_FOG * 0.6, 0.0, 1.0);
#endif

            // Height-based fog thickens in valleys.
            vec3 worldPos = playerPos + cameraPosition;
#if DIMENSIONS_HEIGHT_FOG
            float valley = clamp((72.0 - worldPos.y) / 48.0, 0.0, 1.0);
            amount = clamp(amount * (1.0 + valley * 0.6), 0.0, 1.0);
#endif

            scene = mix(scene, fogCol, amount);

            // Ground mist.
#if FOG_GROUND_MIST
#if FOG_MODE >= 2
            {
                float top = 62.0 + FOG_MIST_HEIGHT * 48.0;
                float mist = clamp((top - worldPos.y) / 24.0, 0.0, 1.0);
                float breakup = anvilFbm(worldPos.xz * 0.06 + frameTimeCounter * 0.02, 0.5);
                mist *= mix(1.0, breakup, FOG_MIST_NOISE);
                mist *= clamp(dist01 * 3.0, 0.0, 1.0);
#if FOG_WATERFALL_BOOST
                if (isWater || anvilIsMat(materials.r, ANVIL_MAT_WATER)) mist *= 1.5;
                mist *= 1.15;
#endif
                scene = mix(scene, fogCol, mist * 0.6);
            }
#endif
#endif
        }
#endif

#if ANVIL_DIM == -1
        // Basalt ash: drifting dark flecks low in the nether air.
        {
            vec3 worldPos = playerPos + cameraPosition;
            float ash = anvilValueNoise(worldPos.xz * 1.5 + vec2(0.0, frameTimeCounter * 0.6));
            ash = step(0.92, ash) * clamp((96.0 - worldPos.y) / 64.0, 0.0, 1.0);
            scene = mix(scene, scene * 0.6 + vec3(0.05), ash * DIMENSIONS_BASALT_ASH * dist01);
        }
#endif
    }

    // --- Whole-frame mood: weather, time of day, dimensions --------------------------

    // Biome contrast: lean the image into the biome's fog tint.
    {
        vec3 biomeTint = normalize(fogColor + 0.001) * 1.732;
        scene = mix(scene, scene * biomeTint, DIMENSIONS_BIOME_CONTRAST * 0.18);
    }

    // Storm darkness + thunder flash + cold haze.
    scene *= 1.0 - WEATHER_STORM_DARKNESS * 0.45 * rainStrength;
    {
        float flash = thunderStrength * WEATHER_THUNDER_FLASH;
        flash *= 0.5 + 0.5 * sin(frameTimeCounter * 35.0 + sin(frameTimeCounter * 13.0) * 6.0);
        scene += vec3(0.8, 0.85, 1.0) * flash * 0.35;
    }
    {
        float cold = clamp(1.0 - temperature * 2.2, 0.0, 1.0);
        float haze = WEATHER_COLD_HAZE * rainStrength * cold;
        scene = mix(scene, vec3(0.75, 0.82, 0.92), haze * 0.35 * clamp(dist01 * 2.0 + 0.2, 0.0, 1.0));
    }

    // Cloud cover dims direct light (sun by day, moon by night).
#if CLOUDS_STYLE != 0
    {
        float cover = cloudCoverageAt(cameraPosition.xz, frameTimeCounter);
        scene *= 1.0 - cover * SUNLIGHT_CLOUD_DIMMING * 0.3 * dayWeight;
        scene *= 1.0 - cover * MOONLIGHT_CLOUD_OCCLUSION * 0.3 * nightWeight;
    }
#endif

    // Time-of-day grading.
    {
        float dawn = anvilDawnWeight(sunAngle);
        float sunset = anvilSunsetWeight(sunAngle);
        float noonW = dayWeight * dayWeight;

        scene = mix(scene, scene * TIME_DAWN_COLOR * 1.8, dawn * TIME_DAWN_WARMTH * 0.45);
        scene = mix(scene, vec3(anvilLuma(scene)) * TIME_DAWN_COLOR * 1.4, dawn * TIME_DAWN_HAZE * 0.3 * dist01);
        scene *= mix(1.0, 0.55 + TIME_NOON_BRIGHTNESS * 0.65, noonW);
        scene = mix(scene, scene * TIME_SUNSET_COLOR * 1.7, sunset * TIME_SUNSET_INTENSITY * 0.5);

        float nightW = nightWeight;
#if TIME_MOON_PHASE_LIGHT
        float phaseDim = float(moonPhase > 4 ? 8 - moonPhase : moonPhase) / 4.0;
        nightW = clamp(nightW * (1.0 + phaseDim * 0.25), 0.0, 1.0);
#endif
        scene *= mix(1.0, 0.35 + TIME_NIGHT_EXPOSURE * 0.9, nightW);
        scene = mix(scene, TIME_NIGHT_COLOR * anvilLuma(scene) * 2.2, nightW * 0.35);
    }

#if ANVIL_DIM == 1
    // End mood: 0 clean, 1 tense, 2 ethereal, 3 dark.
#if DIMENSIONS_END_MOOD == 1
    scene = (scene - 0.5) * 1.12 + 0.5;
    scene *= vec3(0.95, 0.9, 1.0);
#elif DIMENSIONS_END_MOOD == 2
    scene = anvilSaturate(scene, 1.2) * vec3(1.0, 0.95, 1.1) * 1.05;
#elif DIMENSIONS_END_MOOD == 3
    scene *= vec3(0.7, 0.68, 0.78);
    scene = (scene - 0.5) * 1.18 + 0.5;
#endif
#endif

    gl_FragColor = vec4(max(scene, 0.0), 1.0);
}
