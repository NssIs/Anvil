// Ambient occlusion + bounce-light gather. Raw (noisy) results land in
// colortex2 (rgb = bounce light, a = occlusion); the deferred pass denoises
// and applies them.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D colortex0;
uniform sampler2D depthtex0;
uniform sampler2D depthtex1;
uniform mat4 gbufferProjection;
uniform mat4 gbufferProjectionInverse;
uniform float viewWidth;
uniform float viewHeight;
uniform float far;

varying vec2 texcoord;

// The water-ignore option samples the pre-translucent depth buffer so water
// surfaces receive no occlusion.
#if AMBIENT_OCCLUSION_WATER_IGNORE
#define DEPTH_SOURCE depthtex1
#else
#define DEPTH_SOURCE depthtex0
#endif

vec3 projDivide(mat4 m, vec3 p) {
    vec4 h = m * vec4(p, 1.0);
    return h.xyz / h.w;
}

vec3 viewPosAt(vec2 uv, float depth) {
    return projDivide(gbufferProjectionInverse, vec3(uv, depth) * 2.0 - 1.0);
}

// Screen-space normal from depth derivatives.
vec3 normalAt(vec2 uv, float depth, vec2 texel) {
    vec3 center = viewPosAt(uv, depth);
    float depthRight = texture2D(DEPTH_SOURCE, uv + vec2(texel.x, 0.0)).r;
    float depthUp = texture2D(DEPTH_SOURCE, uv + vec2(0.0, texel.y)).r;
    vec3 right = viewPosAt(uv + vec2(texel.x, 0.0), depthRight) - center;
    vec3 up = viewPosAt(uv + vec2(0.0, texel.y), depthUp) - center;
    return normalize(cross(right, up));
}

// Sample counts scale with the global quality profile.
#if AMBIENT_OCCLUSION_SAMPLES == 0
#define AO_BASE_SAMPLES 8
#elif AMBIENT_OCCLUSION_SAMPLES == 1
#define AO_BASE_SAMPLES 16
#elif AMBIENT_OCCLUSION_SAMPLES == 2
#define AO_BASE_SAMPLES 32
#else
#define AO_BASE_SAMPLES 64
#endif
const int aoSampleCount = int(float(AO_BASE_SAMPLES) * ANVIL_PROFILE_MULT);

#if GLOBAL_ILLUMINATION_SAMPLES == 0
#define GI_BASE_SAMPLES 8
#elif GLOBAL_ILLUMINATION_SAMPLES == 1
#define GI_BASE_SAMPLES 16
#elif GLOBAL_ILLUMINATION_SAMPLES == 2
#define GI_BASE_SAMPLES 32
#else
#define GI_BASE_SAMPLES 64
#endif
const int giSampleCount = int(float(GI_BASE_SAMPLES) * ANVIL_PROFILE_MULT);
const int giBounces = GLOBAL_ILLUMINATION_BOUNCE_COUNT + 1;

void main() {
    float depth = texture2D(DEPTH_SOURCE, texcoord).r;

    if (depth >= 1.0) {
        gl_FragData[0] = vec4(0.0, 0.0, 0.0, 1.0); // sky: no occlusion, no bounce
        return;
    }

#if PERFORMANCE_FAST_LIGHTING
    gl_FragData[0] = vec4(0.0, 0.0, 0.0, 1.0);
    return;
#else
    vec2 texel = 1.0 / vec2(viewWidth, viewHeight);
    vec3 viewPos = viewPosAt(texcoord, depth);
    vec3 normal = normalAt(texcoord, depth, texel);
    float dist01 = clamp(length(viewPos) / max(far, 1.0), 0.0, 1.0);

#if AMBIENT_OCCLUSION_DITHER
    float jitter = anvilHash(gl_FragCoord.xy) * ANVIL_TAU;
#else
    float jitter = 0.0;
#endif

    // Screen-space radius for the AO kernel (shrinks with distance).
    float radiusPx = AMBIENT_OCCLUSION_RADIUS * 90.0 / max(-viewPos.z, 1.0);
    radiusPx = clamp(radiusPx, 2.0, 96.0) * QUALITY_PRESETS_EFFECT_DISTANCE;

    // --- Ambient occlusion -------------------------------------------------------
    float occlusion = 0.0;
#if AMBIENT_OCCLUSION_ENABLED
    float weightSum = 0.0;
    for (int i = 0; i < aoSampleCount; i++) {
        float fi = float(i);
        float angle = jitter + fi * 2.39996; // golden-angle spiral
        float rad = radiusPx * sqrt((fi + 0.5) / float(aoSampleCount));
        vec2 offset = vec2(cos(angle), sin(angle)) * rad * texel;

        float sampleDepth = texture2D(DEPTH_SOURCE, texcoord + offset).r;
        vec3 samplePos = viewPosAt(texcoord + offset, sampleDepth);
        vec3 delta = samplePos - viewPos;
        float len = max(length(delta), 0.0001);

        // Method: 0 SSAO sphere, 1 HBAO horizon, 2 GTAO cosine horizon, 3 hybrid.
#if AMBIENT_OCCLUSION_METHOD == 0
        float occ = step(0.02, dot(delta, normal) / len) * (1.0 - smoothstep(0.0, AMBIENT_OCCLUSION_RADIUS * 2.0, len));
#elif AMBIENT_OCCLUSION_METHOD == 1
        float horizonAngle = dot(normalize(delta), normal);
        float occ = clamp(horizonAngle - 0.1, 0.0, 1.0) * (1.0 - smoothstep(0.0, AMBIENT_OCCLUSION_RADIUS * 2.5, len));
#elif AMBIENT_OCCLUSION_METHOD == 2
        float horizonAngle = dot(normalize(delta), normal);
        float occ = clamp(horizonAngle, 0.0, 1.0) * clamp(horizonAngle, 0.0, 1.0) * (1.0 - smoothstep(0.0, AMBIENT_OCCLUSION_RADIUS * 2.5, len));
#else
        float sphereOcc = step(0.02, dot(delta, normal) / len) * (1.0 - smoothstep(0.0, AMBIENT_OCCLUSION_RADIUS * 2.0, len));
        float horizonAngle = clamp(dot(normalize(delta), normal), 0.0, 1.0);
        float occ = mix(sphereOcc, horizonAngle * (1.0 - smoothstep(0.0, AMBIENT_OCCLUSION_RADIUS * 2.5, len)), 0.5);
#endif
        occlusion += occ;
        weightSum += 1.0;
    }
    occlusion /= max(weightSum, 1.0);

    // Distance fade keeps far geometry clean.
    occlusion *= 1.0 - dist01 * AMBIENT_OCCLUSION_DISTANCE_FADE;
#endif

    // --- Bounce light gather -------------------------------------------------------
    vec3 bounce = vec3(0.0);
#if GLOBAL_ILLUMINATION_ENABLED && GLOBAL_ILLUMINATION_METHOD != 0
    {
        float giRadiusPx = GLOBAL_ILLUMINATION_RAY_LENGTH * 2.0 * QUALITY_PRESETS_EFFECT_DISTANCE;
        float giWeight = 0.0;

#if GLOBAL_ILLUMINATION_METHOD != 1
        // Screen-space gather (methods: screen space, hybrid).
        for (int b = 0; b < giBounces; b++) {
            for (int i = 0; i < giSampleCount; i++) {
                float fi = float(i);
                float angle = jitter + fi * 2.39996 + float(b) * 1.1;
                float rad = giRadiusPx * sqrt((fi + 0.5) / float(giSampleCount)) * (1.0 + float(b) * 0.6);
                vec2 sampleUv = texcoord + vec2(cos(angle), sin(angle)) * rad * texel;
                if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) continue;

                float sampleDepth = texture2D(DEPTH_SOURCE, sampleUv).r;
                if (sampleDepth >= 1.0) continue;
                vec3 samplePos = viewPosAt(sampleUv, sampleDepth);
                vec3 delta = samplePos - viewPos;
                float len = length(delta);

                // Thickness check: only nearby geometry within the configured
                // depth band contributes bounce light.
                if (len > GLOBAL_ILLUMINATION_THICKNESS * 8.0) continue;
                float facing = clamp(dot(normalize(delta), normal), 0.0, 1.0);
                vec3 sampleColor = texture2D(colortex0, sampleUv).rgb;
                bounce += sampleColor * facing;
                giWeight += 1.0;
            }
        }
        bounce /= max(giWeight, 1.0);
#endif

#if GLOBAL_ILLUMINATION_METHOD == 1 || GLOBAL_ILLUMINATION_METHOD == 3
        // Ambient bounce: a wide, cheap average of the scene around the pixel.
        vec3 ambient = vec3(0.0);
        for (int i = 0; i < 4; i++) {
            vec2 offset = vec2(cos(float(i) * 1.5708 + jitter), sin(float(i) * 1.5708 + jitter)) * giRadiusPx * 2.0 * texel;
            ambient += texture2D(colortex0, clamp(texcoord + offset, vec2(0.0), vec2(1.0))).rgb;
        }
        bounce += ambient * 0.25 * 0.5;
#endif

        // Color bleeding: saturate or mute the gathered color.
        bounce = anvilSaturate(bounce, GLOBAL_ILLUMINATION_COLOR_BLEED * 2.0);
        bounce *= 1.0 - dist01 * GLOBAL_ILLUMINATION_DISTANCE_FADE;
    }
#endif

    gl_FragData[0] = vec4(bounce, 1.0 - clamp(occlusion, 0.0, 1.0));
#endif
}
