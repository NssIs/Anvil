// Entity rendering: brightness, rim light, hurt flash, saturation, eye glow.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform sampler2D texture;
uniform vec4 entityColor;
uniform float sunAngle;

varying vec2 texcoord;
varying vec2 lmcoord;
varying vec4 vertexColor;
varying vec3 viewNormal;
varying vec3 viewPosV;

void main() {
    vec4 albedo = texture2D(texture, texcoord) * vertexColor;
    float skyLight = clamp(lmcoord.y, 0.0, 1.0);
    float blockLight = clamp(lmcoord.x, 0.0, 1.0);
    float dayWeight = anvilDayCurve(sunAngle);
    float emissive = 0.0;

    // Basic lightmap lighting so entities match the terrain mood.
    float light = 0.22 + 0.78 * max(skyLight * mix(0.3, 1.0, dayWeight), blockLight);
    albedo.rgb *= light;

#if ENTITIES_ENABLED
    albedo.rgb *= ENTITIES_BRIGHTNESS;
    albedo.rgb = anvilSaturate(albedo.rgb, ENTITIES_SATURATION);

    // Rim light: brighten silhouette edges facing away from the camera.
    vec3 viewDir = normalize(-viewPosV);
    float rim = pow(1.0 - clamp(dot(viewNormal, viewDir), 0.0, 1.0), 2.5);
    albedo.rgb += rim * ENTITIES_RIM_LIGHT * 0.4 * (0.4 + skyLight * 0.6);

    // Hurt flash strength (vanilla passes the red overlay via entityColor).
    albedo.rgb = mix(albedo.rgb, entityColor.rgb, entityColor.a * ENTITIES_HURT_FLASH);
#endif

#if EMISSIVE_LIGHT_ENABLED && EMISSIVE_LIGHT_ENTITY_EYES
    // Eye-glow heuristic: bright texels on otherwise unlit mobs (spider eyes,
    // enderman eyes render full-bright in the dark).
    float glow = smoothstep(0.6, 0.9, anvilLuma(albedo.rgb)) * (1.0 - max(skyLight, blockLight));
    albedo.rgb += albedo.rgb * glow * 1.5;
    emissive = glow;
#endif

    gl_FragData[0] = albedo;
    gl_FragData[1] = vec4(ANVIL_MAT_ENTITY, skyLight, blockLight, emissive);
}
