// Sun and moon quads. The Sun size option scales the celestial quad.
#include "/anvil_options.glsl"

varying vec2 texcoord;
varying vec4 glColor;

void main() {
    texcoord = (gl_TextureMatrix[0] * gl_MultiTexCoord0).xy;
    glColor = gl_Color;

    // The celestial quad spans model-space x/z at a fixed height; scaling x/z
    // grows the disc without changing its distance.
    vec4 vertex = gl_Vertex;
    vertex.xz *= 0.5 + SKY_SUN_SIZE * 1.6;
    gl_Position = gl_ProjectionMatrix * gl_ModelViewMatrix * vertex;
}
