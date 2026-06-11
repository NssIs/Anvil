// Sky gradient driven by the Sky options, with sun scatter from the Sunlight
// group. Stars and clouds are added procedurally in the deferred pass.
#include "/anvil_options.glsl"
#include "/lib/common.glsl"

uniform float viewHeight;
uniform vec3 sunPosition;
uniform float sunAngle;

varying vec4 glColor;
varying vec3 viewPosV;

void main() {
    vec3 sky = glColor.rgb;
    vec3 viewDir = normalize(viewPosV);
    vec3 sunDir = normalize(sunPosition);
    float dayWeight = anvilDayCurve(sunAngle);

    // Vertical gradient: horizon height shifts the band, gradient strength bends it.
    float y = clamp(gl_FragCoord.y / max(viewHeight, 1.0), 0.0, 1.0);
    float h = clamp((y - SKY_HORIZON_HEIGHT) / max(1.0 - SKY_HORIZON_HEIGHT, 0.01), 0.0, 1.0);
    float curve = pow(h, mix(2.2, 0.4, SKY_GRADIENT_STRENGTH));
    vec3 gradient = mix(SKY_HORIZON_COLOR, SKY_ZENITH_COLOR, curve);
    gradient *= mix(0.12, 1.0, dayWeight); // keep the gradient dark at night
    sky = mix(gradient, sky, SKY_VANILLA_BLEND);

    // Sun scattering: brighten the sky toward the sun direction.
    float sunDot = clamp(dot(viewDir, sunDir), 0.0, 1.0);
    sky += SKY_HORIZON_COLOR * SKY_SUN_GLOW * 0.25 * pow(sunDot, 4.0) * dayWeight;
    sky += vec3(1.0, 0.85, 0.6) * SUNLIGHT_SKY_SCATTER * 0.35 * pow(sunDot, 8.0) * dayWeight;

    // Horizon warmth at low sun angles.
    float lowSun = max(anvilDawnWeight(sunAngle), anvilSunsetWeight(sunAngle));
    sky += vec3(1.0, 0.5, 0.25) * SUNLIGHT_HORIZON_WARMTH * lowSun * (1.0 - curve) * 0.5;

    // Zenith falloff: darken straight overhead.
    sky *= 1.0 - SUNLIGHT_ZENITH_FALLOFF * 0.4 * curve;

    // Exposure, legacy tint, then saturation.
    sky *= SKY_EXPOSURE * ANVIL_SKY_TINT / max(vec3(0.561, 0.78, 1.0), vec3(0.001));
    sky = anvilSaturate(sky, SKY_SATURATION + 0.5);

#if SKY_BANDING_FIX
    sky += (anvilHash(gl_FragCoord.xy) - 0.5) / 255.0;
#endif

    gl_FragColor = vec4(max(sky, 0.0), glColor.a);
}
