import {
  BackSide,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3
} from '@iwsdk/core';

import { SUN_DIR } from '../constants.js';
import { makeGlow, NOISE_GLSL } from './fx.js';

export interface SkyHandles {
  group: Group;
  uniforms: { uTime: { value: number } };
}

/**
 * A clear afternoon over the coast: a Rayleigh-ish gradient dome, the sun
 * with its glare, and slow fair-weather clouds drifting in from the sea.
 * Also owns the scene's two real lights so everything agrees on the sun.
 */
export function createSky(): SkyHandles {
  const group = new Group();
  const uTime = { value: 0 };
  const sun = new Vector3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z);

  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: { uTime, uSun: { value: sun } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform float uTime;
      uniform vec3 uSun;
      ${NOISE_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        float up = clamp(d.y, -1.0, 1.0);

        // Gradient: deep blue at the zenith, milky haze at the horizon.
        vec3 zenith = vec3(0.12, 0.34, 0.72);
        vec3 mid = vec3(0.38, 0.62, 0.90);
        vec3 horizon = vec3(0.80, 0.86, 0.92);
        float t = pow(max(up, 0.0), 0.55);
        vec3 col = mix(horizon, mid, smoothstep(0.0, 0.35, t));
        col = mix(col, zenith, smoothstep(0.35, 1.0, t));

        // Warm haze around the sun's side of the sky.
        float sunDot = max(dot(d, uSun), 0.0);
        col += vec3(1.0, 0.85, 0.6) * pow(sunDot, 6.0) * 0.28;
        col += vec3(1.0, 0.95, 0.85) * pow(sunDot, 90.0) * 1.2;
        // The disc itself.
        col += vec3(1.0, 0.98, 0.92) * smoothstep(0.9993, 0.9997, sunDot) * 6.0;

        // Clouds: project the view ray onto a plane 1.5km up and sample fbm.
        if (d.y > 0.01) {
          vec2 p = d.xz / (d.y + 0.08) * 1.6;
          p += vec2(uTime * 0.006, uTime * 0.002);
          float n = fbm(vec3(p * 0.9, 3.0));
          float cover = smoothstep(0.52, 0.72, n);
          float thick = smoothstep(0.6, 0.9, n);
          // Fade clouds out toward the horizon so they don't smear.
          float horizonFade = smoothstep(0.02, 0.18, d.y);
          vec3 cloudCol = mix(vec3(0.72, 0.76, 0.84), vec3(1.0, 1.0, 1.0), 1.0 - thick * 0.8);
          cloudCol += vec3(1.0, 0.9, 0.75) * pow(sunDot, 3.0) * 0.25;
          col = mix(col, cloudCol, cover * horizonFade * 0.92);
        }

        // Below the horizon: the sea's colour, so nothing peeks through.
        col = mix(col, vec3(0.16, 0.36, 0.52), smoothstep(0.0, -0.05, up));

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `
  });
  const dome = new Mesh(new SphereGeometry(4800, 48, 32), material);
  dome.frustumCulled = false;
  group.add(dome);

  // Sun glare sprite far out along the sun direction.
  const glare = makeGlow(0xfff3d6, 900, 0.55);
  glare.position.copy(sun).multiplyScalar(4300);
  group.add(glare);

  // The real lights — Lambert meshes get these; shader meshes use LIGHT_GLSL.
  const sunLight = new DirectionalLight(0xfff0dc, 2.6);
  sunLight.position.copy(sun).multiplyScalar(1000);
  group.add(sunLight);
  group.add(sunLight.target);
  const hemi = new HemisphereLight(0x9ec4f0, 0x6d735a, 1.35);
  group.add(hemi);

  return { group, uniforms: { uTime } };
}
