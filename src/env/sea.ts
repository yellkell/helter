import {
  BoxGeometry,
  ConeGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3
} from '@iwsdk/core';

import { PAINT, SUN_DIR } from '../constants.js';
import { NOISE_GLSL } from './fx.js';

export interface SeaHandles {
  group: Group;
  uniforms: { uTime: { value: number } };
  /** Little sailing boats that bob on the swell. */
  boats: Group[];
}

/**
 * The sea: one big plane whose shader rolls a swell through a couple of
 * noise octaves, tints deep-to-shallow by distance from the beach, reflects
 * the sky by fresnel and throws the sun's glitter back at you.
 */
export function createSea(): SeaHandles {
  const group = new Group();
  const uTime = { value: 0 };

  const material = new ShaderMaterial({
    fog: true,
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime,
        uSun: { value: new Vector3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z) }
      }
    ]),
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      uniform float uTime;
      uniform vec3 uSun;
      #include <fog_pars_fragment>
      ${NOISE_GLSL}

      float swell(vec2 p, float t) {
        float h = 0.0;
        h += sin(p.x * 0.11 + p.y * 0.07 + t * 0.9) * 0.55;
        h += sin(p.x * 0.05 - p.y * 0.13 + t * 0.6) * 0.45;
        h += (vnoise(vec3(p * 0.12, t * 0.25)) - 0.5) * 1.4;
        h += (vnoise(vec3(p * 0.45, t * 0.6)) - 0.5) * 0.5;
        return h;
      }

      void main() {
        vec2 p = vWorld.xz;
        float t = uTime;
        // Finite-difference normal from the swell height field.
        float e = 0.6;
        float h0 = swell(p, t);
        float hx = swell(p + vec2(e, 0.0), t);
        float hz = swell(p + vec2(0.0, e), t);
        vec3 n = normalize(vec3(h0 - hx, e * 1.6, h0 - hz));

        vec3 viewDir = normalize(cameraPosition - vWorld);
        float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 4.0);

        // Colour: turquoise in the shallows off the beach, deep blue further out.
        float shallow = 1.0 - smoothstep(320.0, 900.0, vWorld.z);
        vec3 deep = vec3(0.03, 0.16, 0.30);
        vec3 shelf = vec3(0.10, 0.48, 0.52);
        vec3 water = mix(deep, shelf, shallow * 0.85);
        vec3 skyRef = vec3(0.62, 0.76, 0.92);
        vec3 col = mix(water, skyRef, fresnel * 0.85);

        // Sun glitter.
        vec3 refl = reflect(-viewDir, n);
        float spec = pow(max(dot(refl, uSun), 0.0), 220.0);
        col += vec3(1.0, 0.95, 0.85) * spec * 2.4;
        // Soft foam flecks on the crests.
        float crest = smoothstep(0.75, 1.2, h0);
        col = mix(col, vec3(0.9, 0.95, 0.97), crest * 0.35);

        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `
  });

  const plane = new Mesh(new PlaneGeometry(9000, 9000, 1, 1), material);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = 0; // sea level
  group.add(plane);

  // A few sailing boats out on the water.
  const boats: Group[] = [];
  const boatSpots: Array<[number, number, number]> = [
    [180, 720, 0.4],
    [-260, 880, -0.9],
    [520, 1150, 2.2],
    [-640, 1400, 1.4],
    [80, 1700, -2.0]
  ];
  const hullMat = new MeshLambertMaterial({ color: 0xf3efe6 });
  const trimMat = new MeshLambertMaterial({ color: PAINT.sea });
  const sailMat = new MeshLambertMaterial({ color: 0xffffff, side: DoubleSide });
  boatSpots.forEach(([x, z, heading]) => {
    const boat = new Group();
    const hull = new Mesh(new BoxGeometry(3.2, 1.1, 9), hullMat);
    hull.position.y = 0.3;
    const trim = new Mesh(new BoxGeometry(3.4, 0.25, 9.2), trimMat);
    trim.position.y = 0.85;
    const mast = new Mesh(new BoxGeometry(0.16, 11, 0.16), trimMat);
    mast.position.y = 6;
    const sail = new Mesh(new ConeGeometry(2.4, 9, 3, 1, true), sailMat);
    sail.position.set(0, 6.2, 0.8);
    sail.rotation.y = Math.PI / 2;
    boat.add(hull, trim, mast, sail);
    boat.position.set(x, 0, z);
    boat.rotation.y = heading;
    boat.userData.phase = Math.random() * Math.PI * 2;
    group.add(boat);
    boats.push(boat);
  });

  return { group, uniforms: { uTime }, boats };
}
