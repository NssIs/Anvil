// First-person held items: item brightness and held-item glow.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D texture;
uniform float sunAngle;
uniform int heldBlockLightValue;

varying vec2 texcoord;
varying vec2 lmcoord;
varying vec4 vertexColor;

void main() {
    vec4 albedo = texture2D(texture, texcoord) * vertexColor;
    float skyLight = clamp(lmcoord.y, 0.0, 1.0);
    float blockLight = clamp(lmcoord.x, 0.0, 1.0);
    float dayWeight = anvilDayCurve(sunAngle);
    float emissive = 0.0;

    float light = 0.3 + 0.7 * max(skyLight * mix(0.35, 1.0, dayWeight), blockLight);
    albedo.rgb *= light;

#if HANDHELD_ENABLED
    albedo.rgb *= HANDHELD_BRIGHTNESS;

    // Light-emitting held items get a self-glow so they read as the source.
    float held = float(heldBlockLightValue) / 15.0;
    albedo.rgb += albedo.rgb * held * HANDHELD_LIGHT_STRENGTH * HANDHELD_LIGHT_TINT;
#endif

#if EMISSIVE_LIGHT_ENABLED
    // Bright texels on emissive-looking held items glow slightly.
    float glow = smoothstep(0.7, 0.95, anvilLuma(albedo.rgb)) * EMISSIVE_LIGHT_ITEM_GLOW;
    albedo.rgb += albedo.rgb * glow;
    emissive = glow;
#endif

    gl_FragData[0] = albedo;
    gl_FragData[1] = vec4(ANVIL_MAT_NONE, skyLight, blockLight, emissive);
}
