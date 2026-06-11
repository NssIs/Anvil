#ifndef ANVIL_COMMON
#define ANVIL_COMMON
// Shared helpers for the Anvil shader pack. GLSL 1.20 compatible.
// Expects "/anvil_options.glsl" to be included before this file.

#ifndef ANVIL_DIM
#define ANVIL_DIM 0
#endif

#define ANVIL_PI 3.14159265
#define ANVIL_TAU 6.28318531

// Quality profile multiplier (Performance, Balanced, Quality, Ultra).
#if QUALITY_PRESETS_PROFILE == 0
#define ANVIL_PROFILE_MULT 0.5
#elif QUALITY_PRESETS_PROFILE == 1
#define ANVIL_PROFILE_MULT 1.0
#elif QUALITY_PRESETS_PROFILE == 2
#define ANVIL_PROFILE_MULT 1.5
#else
#define ANVIL_PROFILE_MULT 2.0
#endif

// Noise octave count for clouds/mist (select index 0..3 -> 2..5 octaves).
#define ANVIL_NOISE_OCTAVES (QUALITY_PRESETS_NOISE_OCTAVES + 2)

// Material flags written to colortex3.r by the gbuffers passes.
#define ANVIL_MAT_NONE 0.0
#define ANVIL_MAT_PLANT 0.1
#define ANVIL_MAT_LEAVES 0.2
#define ANVIL_MAT_LAVA 0.3
#define ANVIL_MAT_EMISSIVE 0.4
#define ANVIL_MAT_WATER 0.5
#define ANVIL_MAT_PORTAL 0.6
#define ANVIL_MAT_ICE 0.7
#define ANVIL_MAT_GLASS 0.8
#define ANVIL_MAT_PARTICLE 0.9
#define ANVIL_MAT_ENTITY 1.0

bool anvilIsMat(float channel, float flag) {
    return abs(channel - flag) < 0.045;
}

float anvilLuma(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

// Saturation where 1.0 = unchanged.
vec3 anvilSaturate(vec3 color, float amount) {
    return mix(vec3(anvilLuma(color)), color, amount);
}

// Cheap hue rotation (approximate YIQ rotation).
vec3 anvilHueShift(vec3 color, float angle) {
    mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
    mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
    vec3 yiq = toYIQ * color;
    float chroma = length(yiq.yz);
    float h = atan(yiq.z, yiq.y + 1.0e-6) + angle;
    return toRGB * vec3(yiq.x, chroma * cos(h), chroma * sin(h));
}

float anvilHash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

float anvilHash3(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 52.9871))) * 43758.5453);
}

float anvilValueNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = anvilHash(cell);
    float b = anvilHash(cell + vec2(1.0, 0.0));
    float c = anvilHash(cell + vec2(0.0, 1.0));
    float d = anvilHash(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// fbm with the global octave option (constant loop bound).
float anvilFbm(vec2 p, float turbulence) {
    float total = 0.0;
    float amplitude = 0.5;
    float sum = 0.0;
    for (int i = 0; i < ANVIL_NOISE_OCTAVES; i++) {
        total += anvilValueNoise(p) * amplitude;
        sum += amplitude;
        amplitude *= mix(0.42, 0.62, clamp(turbulence, 0.0, 1.0));
        p = p * 2.13 + vec2(17.3, 9.1);
    }
    return total / max(sum, 0.001);
}

// ---- Time of day -------------------------------------------------------------
// sunAngle: 0.0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight.

float anvilDayCurve(float sunAngle) {
    float raw = sin(sunAngle * ANVIL_TAU);
#if TIME_TRANSITION_CURVE == 0
    return clamp(raw * 2.5 + 0.5, 0.0, 1.0);                       // linear-ish
#elif TIME_TRANSITION_CURVE == 1
    return smoothstep(-0.18, 0.22, raw);                           // smooth
#elif TIME_TRANSITION_CURVE == 2
    float v = smoothstep(-0.3, 0.35, raw);                         // cinematic — long dawn/dusk
    return v * v * (3.0 - 2.0 * v);
#else
    return smoothstep(-0.05, 0.1, raw);                            // high contrast — fast flips
#endif
}

// 1.0 around dawn (sunAngle near 0.0), shaped by dawn duration.
float anvilDawnWeight(float sunAngle) {
    float span = 0.035 + TIME_DAWN_DURATION * 0.05;
    float dawn = 1.0 - smoothstep(0.0, span, abs(sunAngle));
    dawn = max(dawn, 1.0 - smoothstep(0.0, span, abs(sunAngle - 1.0)));
    return dawn;
}

// 1.0 around sunset (sunAngle near 0.5).
float anvilSunsetWeight(float sunAngle) {
    float span = 0.035 + (TIME_GOLDEN_HOUR == 1 ? 0.045 : 0.02);
    return 1.0 - smoothstep(0.0, span, abs(sunAngle - 0.5));
}

// ---- Tonemapping ---------------------------------------------------------------

vec3 anvilReinhard(vec3 color, float whitePoint) {
    return color * (1.0 + color / (whitePoint * whitePoint)) / (1.0 + color);
}

vec3 anvilFilmic(vec3 color, float whitePoint) {
    color = max(color - 0.004, 0.0) * (1.0 / max(whitePoint, 0.001));
    vec3 mapped = (color * (6.2 * color + 0.5)) / (color * (6.2 * color + 1.7) + 0.06);
    return mapped;
}

vec3 anvilAces(vec3 color, float whitePoint) {
    color /= max(whitePoint, 0.001);
    return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
}

// ---- Shadow distortion ---------------------------------------------------------
// Must match between shadow.vsh (writing) and the deferred pass (reading).

vec2 anvilDistortShadow(vec2 position) {
    float factor = length(position) * SHADOWS_DISTORTION + (1.0 - SHADOWS_DISTORTION);
    return position / max(factor, 0.05);
}

#endif // ANVIL_COMMON
