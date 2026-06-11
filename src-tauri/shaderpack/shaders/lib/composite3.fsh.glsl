// Bloom pass 2: vertical blur of colortex1, with ghosting suppression.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D colortex1;
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

void main() {
#if BLOOM_ENABLED && ANVIL_BLOOM_PASS
    vec2 texel = 1.0 / vec2(viewWidth, viewHeight);
    float radius = 1.0 + BLOOM_RADIUS * 7.0;
    float sigma = mix(2.5, 1.2, BLOOM_DIFFUSION);

    vec3 center = texture2D(colortex1, texcoord).rgb;
    vec3 sum = vec3(0.0);
    float total = 0.0;
    int half0 = bloomTaps / 2;
    for (int i = -half0; i <= half0; i++) {
        float fi = float(i) / float(max(half0, 1));
        float weight = exp(-fi * fi * sigma);
        vec3 tap = texture2D(colortex1, texcoord + vec2(0.0, float(i) * radius * texel.y)).rgb;
        // Ghosting control: clamp far taps against the center to stop wide
        // double-image halos around hot spots.
        tap = mix(tap, min(tap, center + 0.35), abs(fi) * BLOOM_GHOSTING);
        sum += tap * weight;
        total += weight;
    }

    gl_FragData[0] = vec4(sum / max(total, 0.001), 1.0);
#else
    gl_FragData[0] = vec4(0.0);
#endif
}
