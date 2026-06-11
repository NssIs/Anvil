// Rain/snow streaks. The rain angle option shears the falling quads, snow
// drift adds sideways sway.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform mat4 gbufferModelView;
uniform mat4 gbufferModelViewInverse;
uniform vec3 cameraPosition;
uniform float frameTimeCounter;

varying vec2 texcoord;
varying vec2 lmcoord;
varying vec4 glColor;

void main() {
    texcoord = (gl_TextureMatrix[0] * gl_MultiTexCoord0).xy;
    lmcoord = (gl_TextureMatrix[1] * gl_MultiTexCoord1).xy;
    glColor = gl_Color;

    vec4 viewPos = gl_ModelViewMatrix * gl_Vertex;
    vec3 worldPos = (gbufferModelViewInverse * viewPos).xyz + cameraPosition;

    // Shear precipitation sideways: rain angle in degrees, plus animated snow drift.
    float shear = tan(radians(WEATHER_RAIN_ANGLE)) * 0.35;
    float drift = sin(frameTimeCounter * 1.3 + worldPos.y * 0.5) * WEATHER_SNOW_DRIFT * 0.25;
    vec3 offset = vec3(shear + drift, 0.0, shear * 0.4);
    float heightInQuad = fract(worldPos.y * 0.25);
    viewPos.xyz += mat3(gbufferModelView) * (offset * heightInQuad);

    gl_Position = gl_ProjectionMatrix * viewPos;
}
