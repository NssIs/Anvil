// Translucents: water, stained glass, ice, nether portals.
// Wave displacement consumes the Water option group.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

attribute vec4 mc_Entity;

uniform mat4 gbufferModelView;
uniform mat4 gbufferModelViewInverse;
uniform vec3 cameraPosition;
uniform float frameTimeCounter;

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
    materialFlag = ANVIL_MAT_GLASS;
    if (blockId == 10008) materialFlag = ANVIL_MAT_WATER;
    if (blockId == 10005) materialFlag = ANVIL_MAT_PORTAL;
    if (blockId == 10006) materialFlag = ANVIL_MAT_ICE;

    vec4 viewPos = gl_ModelViewMatrix * gl_Vertex;
    worldPos = (gbufferModelViewInverse * viewPos).xyz + cameraPosition;

#if WATER_ENABLED && ANVIL_WATER_RIPPLES
    if (anvilIsMat(materialFlag, ANVIL_MAT_WATER)) {
        float freq = mix(2.0, 0.45, WATER_WAVE_SCALE);
        float speed = frameTimeCounter * (0.5 + WATER_WAVE_SPEED * 2.5);
        float wave = sin(worldPos.x * freq + speed) * cos(worldPos.z * freq * 0.8 + speed * 0.85);
        wave += sin((worldPos.x + worldPos.z) * freq * 1.7 + speed * 1.3) * 0.5;
        vec3 offset = vec3(0.0, wave * WATER_WAVE_HEIGHT * 0.08, 0.0);
        viewPos.xyz += mat3(gbufferModelView) * offset;
    }
#endif

    viewPosV = viewPos.xyz;
    gl_Position = gl_ProjectionMatrix * viewPos;
}
