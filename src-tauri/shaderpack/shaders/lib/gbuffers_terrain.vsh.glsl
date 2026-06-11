// Terrain vertex pass body — included by gbuffers_terrain.vsh (per dimension).
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

attribute vec4 mc_Entity;

uniform mat4 gbufferModelView;
uniform mat4 gbufferModelViewInverse;
uniform vec3 cameraPosition;
uniform float frameTimeCounter;
uniform float rainStrength;

varying vec2 texcoord;
varying vec2 lmcoord;
varying vec4 vertexColor;
varying vec3 viewNormal;
varying vec3 viewPosV;
varying vec3 worldPos;
varying float materialFlag;

void main() {
    texcoord = (gl_TextureMatrix[0] * gl_MultiTexCoord0).xy;
    lmcoord = (gl_TextureMatrix[1] * gl_MultiTexCoord1).xy;
    vertexColor = gl_Color;
    viewNormal = normalize(gl_NormalMatrix * gl_Normal);

    int blockId = int(mc_Entity.x);
    materialFlag = ANVIL_MAT_NONE;
    if (blockId == 10001) materialFlag = ANVIL_MAT_PLANT;
    if (blockId == 10002) materialFlag = ANVIL_MAT_LEAVES;
    if (blockId == 10003) materialFlag = ANVIL_MAT_LAVA;
    if (blockId == 10004) materialFlag = ANVIL_MAT_EMISSIVE;

    vec4 viewPos = gl_ModelViewMatrix * gl_Vertex;
    worldPos = (gbufferModelViewInverse * viewPos).xyz + cameraPosition;

    // --- Wind: vertex waving for plants and leaves ------------------------------
#if ANVIL_WAVING_FOLIAGE && WIND_ENABLED
    float waving = 0.0;
#if WIND_PLANTS
    if (anvilIsMat(materialFlag, ANVIL_MAT_PLANT)) waving = 1.0;
#endif
#if WIND_LEAVES
    if (anvilIsMat(materialFlag, ANVIL_MAT_LEAVES)) waving = 0.7;
#endif
    if (waving > 0.0) {
        float gust = 1.0 + rainStrength * WIND_RAIN_BOOST * 2.0;
        float speed = frameTimeCounter * (0.6 + WIND_SPEED * 2.4) * gust;
        vec3 phase = worldPos * vec3(0.5, 0.4, 0.5);
        vec3 sway;
        sway.x = sin(phase.x + phase.z + speed) * cos(phase.z * 1.3 + speed * 0.7);
        sway.z = sin(phase.z * 1.1 + speed * 0.9) * cos(phase.x * 0.7 + speed * 0.6);
        sway.y = sin(phase.x + phase.z * 1.7 + speed * 1.3) * 0.3;
        vec3 offset = sway * (WIND_STRENGTH * 0.08 * waving * gust);
        viewPos.xyz += mat3(gbufferModelView) * offset;
    }
#endif

    viewPosV = viewPos.xyz;
    gl_Position = gl_ProjectionMatrix * viewPos;
}
