// Rain and snow appearance: opacity, streak style, snow density and softness.
// Rain and snow share this pass; snow reads as bright/desaturated texels.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D texture;

varying vec2 texcoord;
varying vec2 lmcoord;
varying vec4 glColor;

void main() {
    vec4 color = texture2D(texture, texcoord) * glColor;

    // Snow texels are bright and grey; rain texels are dim and blue-ish.
    float luma = anvilLuma(color.rgb);
    float blueness = color.b - (color.r + color.g) * 0.5;
    float snowiness = clamp(luma * 2.0 - blueness * 4.0, 0.0, 1.0);

    // --- Rain ---------------------------------------------------------------------
    float rainAlpha = WEATHER_RAIN_OPACITY;
    // Streak style: 0 vanilla, 1 thin, 2 cinematic, 3 heavy.
#if WEATHER_RAIN_STREAK_STYLE == 1
    rainAlpha *= 0.7;
    color.rgb *= 1.1;
#elif WEATHER_RAIN_STREAK_STYLE == 2
    rainAlpha *= 0.85;
    color.rgb = mix(color.rgb, vec3(0.65, 0.75, 0.9) * luma * 2.0, 0.5);
#elif WEATHER_RAIN_STREAK_STYLE == 3
    rainAlpha *= 1.35;
    color.rgb *= 0.9;
#endif

    // --- Snow ---------------------------------------------------------------------
    float snowAlpha = 0.4 + WEATHER_SNOW_DENSITY * 0.8;
#if WEATHER_SNOW_SOFTEN
    color.rgb = mix(color.rgb, vec3(luma), snowiness * 0.6);   // soften snow contrast
    snowAlpha *= 0.85;
#endif

    color.a *= mix(rainAlpha, snowAlpha, snowiness);

    gl_FragColor = color;
}
