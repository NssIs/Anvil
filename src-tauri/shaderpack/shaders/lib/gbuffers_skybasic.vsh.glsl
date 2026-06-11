varying vec4 glColor;
varying vec3 viewPosV;

void main() {
    gl_Position = ftransform();
    glColor = gl_Color;
    viewPosV = (gl_ModelViewMatrix * gl_Vertex).xyz;
}
