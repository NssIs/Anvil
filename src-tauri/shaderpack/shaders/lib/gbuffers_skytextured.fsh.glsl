// Sun and moon appearance: celestial style, sun glow, moon brightness.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D texture;
uniform float sunAngle;

varying vec2 texcoord;
varying vec4 glColor;

void main() {
    vec4 color = texture2D(texture, texcoord) * glColor;
    float dayWeight = anvilDayCurve(sunAngle);

    // Day favors the sun quad, night the moon quad.
    float sunWeight = dayWeight;
    float moonWeight = 1.0 - dayWeight;

    // Celestial style: 0 soft disk, 1 sharp vanilla, 2 cinematic glow, 3 realistic.
    float luma = anvilLuma(color.rgb);
#if SKY_CELESTIAL_STYLE == 0
    color.rgb *= 0.9;
    color.rgb += color.rgb * smoothstep(0.2, 0.9, luma) * 0.35; // soft center lift
#elif SKY_CELESTIAL_STYLE == 2
    color.rgb *= 1.1;
    color.rgb += color.rgb * 0.6;                               // heavy glow, bloom catches it
#elif SKY_CELESTIAL_STYLE == 3
    color.rgb = mix(color.rgb, color.rgb * color.rgb * 1.6, 0.5); // tighter, hotter core
#endif

    color.rgb *= 1.0 + SKY_SUN_GLOW * sunWeight * 0.8;
    color.rgb *= mix(1.0, SKY_MOON_BRIGHTNESS * 2.0, moonWeight);

    gl_FragColor = color;
}
