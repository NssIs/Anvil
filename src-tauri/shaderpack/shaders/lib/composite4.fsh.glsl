// Camera effects: depth of field and motion blur.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D colortex0;
uniform sampler2D depthtex0;
uniform mat4 gbufferProjectionInverse;
uniform mat4 gbufferModelViewInverse;
uniform mat4 gbufferPreviousProjection;
uniform mat4 gbufferPreviousModelView;
uniform vec3 cameraPosition;
uniform vec3 previousCameraPosition;
uniform float viewWidth;
uniform float viewHeight;
uniform float far;
uniform float centerDepthSmooth;

varying vec2 texcoord;

vec3 projDivide(mat4 m, vec3 p) {
    vec4 h = m * vec4(p, 1.0);
    return h.xyz / h.w;
}

#if DEPTH_OF_FIELD_QUALITY == 0
#define DOF_TAPS 6
#elif DEPTH_OF_FIELD_QUALITY == 1
#define DOF_TAPS 10
#elif DEPTH_OF_FIELD_QUALITY == 2
#define DOF_TAPS 16
#else
#define DOF_TAPS 24
#endif
const int dofTaps = int(float(DOF_TAPS) * ANVIL_PROFILE_MULT);

const int mbSamples = (MOTION_BLUR_SAMPLES + 1) * 4;

void main() {
    vec3 color = texture2D(colortex0, texcoord).rgb;
    float depth = texture2D(depthtex0, texcoord).r;
    vec2 texel = 1.0 / vec2(viewWidth, viewHeight);

    // --- Depth of field ------------------------------------------------------------
#if DEPTH_OF_FIELD_ENABLED
    {
        float fragDist = length(projDivide(gbufferProjectionInverse, vec3(texcoord, depth) * 2.0 - 1.0));

#if DEPTH_OF_FIELD_FOCUS == 0
        // Smoothed center depth (Iris eases it over time), so focus glides to a
        // new target instead of snapping the frame the crosshair crosses an edge.
        float focusDist = length(projDivide(gbufferProjectionInverse, vec3(0.5, 0.5, centerDepthSmooth) * 2.0 - 1.0));
#else
        float focusDist = DEPTH_OF_FIELD_FOCAL_DISTANCE * far * 0.5;
#endif

        float coc = abs(fragDist - focusDist) / max(focusDist, 1.0);
        coc = clamp(coc * DEPTH_OF_FIELD_STRENGTH * 2.0, 0.0, DEPTH_OF_FIELD_MAX_BLUR) * 24.0;

        if (coc > 0.5) {
            vec3 sum = color;
            float total = 1.0;
            for (int i = 0; i < dofTaps; i++) {
                float angle = float(i) * 2.39996;
                float rad = coc * sqrt((float(i) + 0.5) / float(dofTaps));
                vec2 uv = texcoord + vec2(cos(angle), sin(angle)) * rad * texel;
                sum += texture2D(colortex0, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
                total += 1.0;
            }
            color = sum / total;
        }
    }
#endif

    // --- Motion blur ----------------------------------------------------------------
#if MOTION_BLUR_ENABLED
    if (depth > 0.56) { // skip the first-person hand
        // Reproject this pixel into the previous frame.
        vec3 viewPos = projDivide(gbufferProjectionInverse, vec3(texcoord, depth) * 2.0 - 1.0);
        vec3 playerPos = (gbufferModelViewInverse * vec4(viewPos, 1.0)).xyz;
        vec3 prevPlayerPos = playerPos + (cameraPosition - previousCameraPosition) * MOTION_BLUR_TRANSLATION;
        vec3 prevView = (gbufferPreviousModelView * vec4(prevPlayerPos, 1.0)).xyz;
        vec3 prevClip = projDivide(gbufferPreviousProjection, prevView);
        vec2 prevUv = prevClip.xy * 0.5 + 0.5;

        vec2 velocity = (texcoord - prevUv) * MOTION_BLUR_STRENGTH * 0.6;
        float speed = length(velocity);
        if (speed > 0.0005) {
            velocity = velocity / max(speed, 0.0001) * min(speed, 0.05);
            vec3 sum = color;
            float total = 1.0;
            for (int i = 1; i < mbSamples; i++) {
                vec2 uv = texcoord - velocity * (float(i) / float(mbSamples));
                if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
                sum += texture2D(colortex0, uv).rgb;
                total += 1.0;
            }
            color = sum / total;
        }
    }
#endif

    gl_FragData[0] = vec4(color, 1.0);
}
