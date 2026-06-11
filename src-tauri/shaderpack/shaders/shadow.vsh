#version 120
// Shadow map pass. Applies the same distortion the deferred pass uses when
// sampling, concentrating texels near the camera (Shadow focus option).
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

varying vec2 texcoord;
varying vec4 glColor;

void main() {
    gl_Position = ftransform();
    gl_Position.xy = anvilDistortShadow(gl_Position.xy);
    texcoord = (gl_TextureMatrix[0] * gl_MultiTexCoord0).xy;
    glColor = gl_Color;
}
