// Bloom pass 1: threshold extraction + horizontal blur into colortex1.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D colortex0;
uniform sampler2D colortex3;
uniform float viewWidth;
uniform float viewHeight;

varying vec2 texcoord;

#if BLOOM_QUALITY == 0
#define BLOOM_TAPS 5
#elif BLOOM_QUALITY == 1
#define BLOOM_TAPS 9
#elif BLOOM_QUALITY == 2
#define BLOOM_TAPS 13
#else
#define BLOOM_TAPS 19
#endif
const int bloomTaps = int(float(BLOOM_TAPS) * ANVIL_PROFILE_MULT) / 2 * 2 + 1;

vec3 bloomSource(vec2 uv) {
    vec3 color = texture2D(colortex0, uv).rgb;
    float luma = anvilLuma(color);
    float emissive = texture2D(colortex3, uv).a;

    // Threshold with a soft knee.
    float knee = BLOOM_SOFT_KNEE * 0.5 + 0.05;
    float threshold = BLOOM_THRESHOLD * 0.45;
    float response = smoothstep(threshold - knee, threshold + knee, luma);

    // Source bias: 0 all bright pixels, 1 highlights, 2 emissive only, 3 sun+emissive.
#if BLOOM_SOURCE_BIAS == 0
    float weight = response * 0.8 + luma * 0.2;
#elif BLOOM_SOURCE_BIAS == 1
    float weight = response;
#elif BLOOM_SOURCE_BIAS == 2
    float weight = emissive * (0.4 + response * 0.6);
#else
    float weight = max(emissive * 0.8, response * smoothstep(0.75, 0.98, luma));
#endif

    // Emissive halo shaping from the Emissive light group: radius widens the
    // halo (applied as a gain here, blur spreads it), falloff steepens it.
    weight *= 1.0 + emissive * EMISSIVE_LIGHT_RADIUS * 1.5;
    weight = pow(clamp(weight, 0.0, 1.0), clamp(EMISSIVE_LIGHT_FALLOFF * 0.4 + 0.42, 0.25, 2.0));

    // Firefly rejection clamps isolated ultra-bright pixels.
    vec3 result = color * weight;
    float cap = mix(8.0, 1.2, BLOOM_FIREFLY_REJECTION);
    return min(result, vec3(cap));
}

void main() {
#if BLOOM_ENABLED && ANVIL_BLOOM_PASS
    vec2 texel = 1.0 / vec2(viewWidth, viewHeight);
    float radius = (1.0 + BLOOM_RADIUS * 7.0) * (1.0 + BLOOM_ANAMORPHIC * 1.5);
    float sigma = mix(2.5, 1.2, BLOOM_DIFFUSION); // diffusion softens the falloff

    vec3 sum = vec3(0.0);
    float total = 0.0;
    int half0 = bloomTaps / 2;
    for (int i = -half0; i <= half0; i++) {
        float fi = float(i) / float(max(half0, 1));
        float weight = exp(-fi * fi * sigma);
        sum += bloomSource(texcoord + vec2(float(i) * radius * texel.x, 0.0)) * weight;
        total += weight;
    }

    gl_FragData[0] = vec4(sum / max(total, 0.001), 1.0);
#else
    gl_FragData[0] = vec4(0.0);
#endif
}
