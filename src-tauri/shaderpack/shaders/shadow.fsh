#version 120
#include "/anvil_options.glsl"

uniform sampler2D texture;

varying vec2 texcoord;
varying vec4 glColor;

void main() {
    vec4 color = texture2D(texture, texcoord) * glColor;
    if (color.a < 0.1) {
        discard;
    }
    gl_FragColor = color;
}
