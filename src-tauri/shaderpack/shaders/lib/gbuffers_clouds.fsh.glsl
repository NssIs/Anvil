// Vanilla cloud geometry. Only used for the "vanilla flat" cloud style — the
// other styles render procedural clouds in the deferred pass instead.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D texture;
uniform float sunAngle;

varying vec2 texcoord;
varying vec4 glColor;

void main() {
#if CLOUDS_STYLE != 0
    discard;
#else
    vec4 color = texture2D(texture, texcoord) * glColor;
    float dayWeight = anvilDayCurve(sunAngle);

    color.a *= 0.35 + CLOUDS_DENSITY * 0.85;
    color.rgb *= 1.0 + CLOUDS_SUN_SCATTER * 0.25 * dayWeight;
    color.rgb = mix(color.rgb, CLOUDS_NIGHT_TINT, (1.0 - dayWeight) * 0.7);

    gl_FragColor = color;
#endif
}
