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

        // Storybook gradient: saturated blue overhead, pale at the horizon.
        vec3 zenith = vec3(0.16, 0.50, 0.94);
        vec3 mid = vec3(0.46, 0.74, 0.97);
        vec3 horizon = vec3(0.84, 0.92, 0.98);
        float t = pow(max(up, 0.0), 0.6);
        vec3 col = mix(horizon, mid, smoothstep(0.0, 0.3, t));
        col = mix(col, zenith, smoothstep(0.3, 1.0, t));

        // A big flat sun with a soft warm halo.
        float sunDot = max(dot(d, uSun), 0.0);
        col += vec3(1.0, 0.86, 0.6) * smoothstep(0.990, 0.9985, sunDot) * 0.35;
        col = mix(col, vec3(1.0, 0.97, 0.80), smoothstep(0.99880, 0.99905, sunDot));

        // Puffy hard-edged clouds: one threshold for the body, a second
        // sample nudged toward the ground for a shaded underside.
        if (d.y > 0.01) {
          vec2 p = d.xz / (d.y + 0.08) * 1.6;
          p += vec2(uTime * 0.006, uTime * 0.002);
          float n = fbm(vec3(p * 0.9, 3.0));
          float body = smoothstep(0.545, 0.565, n);
          float n2 = fbm(vec3((p + vec2(0.0, 0.10)) * 0.9, 3.0));
          float lit = smoothstep(0.565, 0.585, n2);
          vec3 cloudCol = mix(vec3(0.76, 0.84, 0.95), vec3(1.0), lit);
          cloudCol += vec3(1.0, 0.9, 0.7) * pow(sunDot, 3.0) * 0.12;
          float horizonFade = smoothstep(0.02, 0.16, d.y);
          col = mix(col, cloudCol, body * horizonFade);
        }

        // Below the horizon: the sea's colour, so nothing peeks through.
        col = mix(col, vec3(0.10, 0.42, 0.66), smoothstep(0.0, -0.05, up));

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
  const glare = makeGlow(0xfff3d6, 700, 0.35);
  glare.position.copy(sun).multiplyScalar(4300);
  group.add(glare);

  // The real lights — Lambert meshes get these; shader meshes use LIGHT_GLSL.
  const sunLight = new DirectionalLight(0xfff0dc, 2.4);
  sunLight.position.copy(sun).multiplyScalar(1000);
  group.add(sunLight);
  group.add(sunLight.target);
  const hemi = new HemisphereLight(0xa8ccf5, 0x7a8a60, 1.5);
  group.add(hemi);

  return { group, uniforms: { uTime } };
}
