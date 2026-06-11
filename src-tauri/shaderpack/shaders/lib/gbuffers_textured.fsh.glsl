// Particles and other textured quads: brightness, emissive boost, saturation.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D texture;
uniform float sunAngle;

varying vec2 texcoord;
varying vec2 lmcoord;
varying vec4 vertexColor;

void main() {
    vec4 albedo = texture2D(texture, texcoord) * vertexColor;
    float skyLight = clamp(lmcoord.y, 0.0, 1.0);
    float blockLight = clamp(lmcoord.x, 0.0, 1.0);
    float dayWeight = anvilDayCurve(sunAngle);
    float emissive = 0.0;

    float light = 0.28 + 0.72 * max(skyLight * mix(0.32, 1.0, dayWeight), blockLight);
    albedo.rgb *= light;

#if PARTICLES_ENABLED
    albedo.rgb *= PARTICLES_BRIGHTNESS;
    albedo.rgb = anvilSaturate(albedo.rgb, PARTICLES_SATURATION);

    // Bright particles (flames, embers, glints) get an emissive lift.
    float glow = smoothstep(0.65, 0.95, anvilLuma(albedo.rgb)) * PARTICLES_EMISSIVE_BOOST;
    albedo.rgb += albedo.rgb * glow;
    emissive = glow;
#endif

    gl_FragData[0] = albedo;
    gl_FragData[1] = vec4(ANVIL_MAT_PARTICLE, skyLight, blockLight, emissive);
}
