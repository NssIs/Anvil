// Final pass: bloom combine, exposure/tonemap, color grade, contrast,
// screen effects, lens effects, sharpening, and debug views.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D colortex0;
uniform sampler2D colortex1;
uniform sampler2D colortex2;
uniform sampler2D colortex3;
uniform sampler2D depthtex0;
uniform sampler2D shadowtex0;
uniform mat4 gbufferProjection;
uniform vec3 sunPosition;
uniform float sunAngle;
uniform float frameTimeCounter;
uniform float viewWidth;
uniform float viewHeight;
uniform int isEyeInWater;
uniform ivec2 eyeBrightnessSmooth;

varying vec2 texcoord;

vec3 sampleScene(vec2 uv) {
    return texture2D(colortex0, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
}

void main() {
    vec2 uv = texcoord;
    float dayWeight = anvilDayCurve(sunAngle);
    float nightWeight = 1.0 - dayWeight;
    vec2 texel = 1.0 / vec2(viewWidth, viewHeight);
    vec2 centered = uv - 0.5;

    // --- Underwater distortion ----------------------------------------------------
#if SCREEN_EFFECTS_ENABLED
    if (isEyeInWater == 1) {
        float wobble = sin(uv.y * 22.0 + frameTimeCounter * 2.4) * cos(uv.x * 18.0 + frameTimeCounter * 1.9);
        uv += wobble * SCREEN_EFFECTS_UNDERWATER_DISTORTION * 0.006;
    }
#endif

    // --- Chromatic aberration (sampled with the base image) -------------------------
    vec3 color;
#if LENS_EFFECTS_ENABLED
    {
        vec2 caOffset = centered * LENS_EFFECTS_CHROMATIC_ABERRATION * 0.012 * dot(centered, centered) * 4.0;
        color.r = sampleScene(uv + caOffset).r;
        color.g = sampleScene(uv).g;
        color.b = sampleScene(uv - caOffset).b;
    }
#else
    color = sampleScene(uv);
#endif

    // --- Bloom combine ----------------------------------------------------------------
#if BLOOM_ENABLED && ANVIL_BLOOM_PASS
    {
        vec3 bloom = texture2D(colortex1, uv).rgb * BLOOM_TINT;

        // Color preservation: push the bloom toward the underlying scene color.
        vec3 sceneChroma = color / max(anvilLuma(color), 0.05);
        bloom = mix(bloom, bloom * clamp(sceneChroma, 0.4, 2.0), BLOOM_COLOR_PRESERVE);

        float strength = BLOOM_INTENSITY * (0.5 + ANVIL_BLOOM * 1.25);
        strength *= 1.0 - BLOOM_NIGHT_LIMIT * 0.7 * nightWeight;
#if BLOOM_EXPOSURE_PROTECTION
        strength /= 1.0 + anvilLuma(color) * 1.5;
#endif
        color += bloom * strength;
    }
#endif

    // --- Exposure & tonemap --------------------------------------------------------------
#if EXPOSURE_ENABLED
    {
        color *= exp2(EXPOSURE_VALUE);
        // Night lift: brighten only when the frame is genuinely dark at night.
        color += vec3(EXPOSURE_NIGHT_LIFT * 0.05) * nightWeight * (1.0 - clamp(anvilLuma(color) * 4.0, 0.0, 1.0));

#if EXPOSURE_TONEMAP == 1
        color = anvilReinhard(color, EXPOSURE_WHITE_POINT);
#elif EXPOSURE_TONEMAP == 2
        color = anvilFilmic(color, EXPOSURE_WHITE_POINT);
#elif EXPOSURE_TONEMAP == 3
        color = anvilAces(color, EXPOSURE_WHITE_POINT);
#endif
    }
#endif
    color *= ANVIL_EXPOSURE * ANVIL_LIGHT_TINT;

    // --- Color grade ------------------------------------------------------------------------
#if COLOR_GRADE_ENABLED
    {
        color *= vec3(1.0 + COLOR_GRADE_TEMPERATURE * 0.25, 1.0 + COLOR_GRADE_TINT * 0.2, 1.0 - COLOR_GRADE_TEMPERATURE * 0.25);

        // Vibrance: saturate muted colors more than already-rich ones.
        float maxc = max(color.r, max(color.g, color.b));
        float minc = min(color.r, min(color.g, color.b));
        float sat = maxc - minc;
        color = anvilSaturate(color, 1.0 + COLOR_GRADE_VIBRANCE * (1.0 - sat));

        // Lift / gamma / gain.
        color = clamp(color + COLOR_GRADE_LIFT * 0.5, 0.0, 4.0);
        color = pow(max(color, 0.0), vec3(1.0 / max(COLOR_GRADE_GAMMA, 0.05)));
        color *= COLOR_GRADE_GAIN;
    }
#endif

    // --- Contrast ------------------------------------------------------------------------------
#if CONTRAST_ENABLED
    {
        color = (color - CONTRAST_PIVOT) * CONTRAST_AMOUNT + CONTRAST_PIVOT;
        // Shadow crush deepens blacks; highlight rolloff soft-clips whites.
        color -= CONTRAST_SHADOW_CRUSH * 0.25 * clamp(1.0 - color * 4.0, 0.0, 1.0);
        vec3 soft = 1.0 - exp(-color * 1.6);
        color = mix(color, soft, CONTRAST_HIGHLIGHT_ROLLOFF * clamp((color - 0.7) * 3.0, 0.0, 1.0));
    }
#endif
    color = (color - 0.5) * ANVIL_CONTRAST + 0.5;
    color = anvilSaturate(color, ANVIL_SATURATION);

    // --- Situational screen effects ----------------------------------------------------------------
#if SCREEN_EFFECTS_ENABLED
    {
        if (isEyeInWater == 1) {
            color = mix(color, color * vec3(0.45, 0.75, 0.95) + vec3(0.0, 0.02, 0.05), SCREEN_EFFECTS_UNDERWATER_TINT * 0.7);
        }

        float eyeSky = float(eyeBrightnessSmooth.y) / 240.0;
        float eyeBlock = float(eyeBrightnessSmooth.x) / 240.0;
        float darkness = clamp(1.0 - max(eyeSky * mix(0.3, 1.0, dayWeight), eyeBlock), 0.0, 1.0);

        // Human night vision: colors wash out in darkness.
        color = anvilSaturate(color, 1.0 - SCREEN_EFFECTS_NIGHT_DESATURATION * darkness * 0.8);
        // Unlit caves press in.
        color *= 1.0 - SCREEN_EFFECTS_CAVE_DARKENING * darkness * (1.0 - eyeSky) * 0.45;
    }
#endif

    // --- Lens effects --------------------------------------------------------------------------------
#if LENS_EFFECTS_ENABLED
    {
        // Vignette with adjustable roundness.
        vec2 v = centered * vec2(mix(1.4, 1.0, LENS_EFFECTS_VIGNETTE_ROUNDNESS), 1.0);
        float vignette = 1.0 - smoothstep(0.35, 0.95, length(v)) * LENS_EFFECTS_VIGNETTE;
        color *= vignette;

        // Sun glare when looking toward a visible sun.
        vec4 sunClip = gbufferProjection * vec4(sunPosition, 1.0);
        if (sunClip.w > 0.0) {
            vec2 sunUv = sunClip.xy / sunClip.w * 0.5 + 0.5;
            if (sunUv.x > -0.2 && sunUv.x < 1.2 && sunUv.y > -0.2 && sunUv.y < 1.2) {
                float sunDepth = texture2D(depthtex0, clamp(sunUv, vec2(0.01), vec2(0.99))).r;
                if (sunDepth >= 1.0) {
                    float glare = 1.0 - clamp(length(uv - sunUv) * 1.6, 0.0, 1.0);
                    color += vec3(1.0, 0.92, 0.75) * glare * glare * LENS_EFFECTS_SUN_FLARE * dayWeight * 0.8;
                }
            }
        }

        // Animated film grain.
        float grain = anvilHash(uv * vec2(viewWidth, viewHeight) + fract(frameTimeCounter) * 100.0) - 0.5;
        color += grain * LENS_EFFECTS_FILM_GRAIN * 0.12;
    }
#endif
#if ANVIL_VIGNETTE
    color *= 1.0 - distance(uv, vec2(0.5)) * 0.5;
#endif

    // --- Sharpening -------------------------------------------------------------------------------------
#if SHARPENING_ENABLED
    {
        float radius = 0.5 + SHARPENING_RADIUS * 1.5;
        vec3 blurred = sampleScene(uv + vec2(texel.x, 0.0) * radius)
                     + sampleScene(uv - vec2(texel.x, 0.0) * radius)
                     + sampleScene(uv + vec2(0.0, texel.y) * radius)
                     + sampleScene(uv - vec2(0.0, texel.y) * radius);
        blurred *= 0.25;
        vec3 detail = color - blurred;
        // Edge protect: clamp the added detail so strong edges don't halo.
        float cap = mix(0.5, 0.08, SHARPENING_EDGE_PROTECT);
        detail = clamp(detail, -cap, cap);
        color += detail * SHARPENING_AMOUNT * 1.2;
    }
#endif
#if ANVIL_SHARPEN
    color += (color - vec3(anvilLuma(color))) * 0.15;
#endif

    // --- Debug views ----------------------------------------------------------------------------------------
#if DEBUG_VIEW != 0
    if (uv.x > 1.0 - DEBUG_SPLIT) {
#if DEBUG_VIEW == 1
        float depth = texture2D(depthtex0, uv).r;
        color = vec3(pow(depth, 32.0));
#elif DEBUG_VIEW == 2
        vec4 materials = texture2D(colortex3, uv);
        color = vec3(materials.b, materials.g, 0.0); // r = block light, g = sky light
#elif DEBUG_VIEW == 3
        color = vec3(texture2D(colortex2, uv).a);
#elif DEBUG_VIEW == 4
        color = vec3(texture2D(shadowtex0, uv).r);
#else
        vec4 materials = texture2D(colortex3, uv);
        color = vec3(materials.r, materials.a, 1.0 - materials.r); // flags + emissive
#endif
    }
#endif

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
