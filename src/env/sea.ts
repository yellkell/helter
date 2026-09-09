import {
  BoxGeometry,
  ConeGeometry,
  DoubleSide,
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3
} from '@iwsdk/core';

import { PAINT, SUN_DIR } from '../constants.js';
import { addOutline, LIGHT_GLSL, NOISE_GLSL, toon } from './fx.js';
import { LAND_HEIGHT_GLSL } from './terrain.js';

export interface SeaHandles {
  group: Group;
  uniforms: { uTime: { value: number } };
  /** Little sailing boats that bob on the swell. */
  boats: Group[];
}

/**
 * Cartoon sea: flat colour bands by depth (it knows the shape of the land
 * it laps against), a lacy foam line where it meets the beach, drifting
 * crest streaks, hard sun glints, and a hint of sky in the fresnel.
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
      ${LIGHT_GLSL}
      ${LAND_HEIGHT_GLSL}

      void main() {
        vec2 p = vWorld.xz;
        float t = uTime;
        float depth = -landHeight(p); // metres of water under this point

        // Flat colour bands by depth.
        vec3 shallow = vec3(0.22, 0.72, 0.68);
        vec3 mid = vec3(0.06, 0.42, 0.62);
        vec3 deep = vec3(0.02, 0.20, 0.44);
        vec3 col = deep;
        col = mix(col, mid, 1.0 - smoothstep(9.0, 11.0, depth));
        col = mix(col, shallow, 1.0 - smoothstep(2.6, 3.4, depth));

        // A gentle swell, only for the glints and the sky tint.
        float e = 0.8;
        float h0 = vnoise(vec3(p * 0.09, t * 0.25)) + sin(p.x * 0.07 + t * 0.7) * 0.4;
        float hx = vnoise(vec3((p + vec2(e, 0.0)) * 0.09, t * 0.25)) + sin((p.x + e) * 0.07 + t * 0.7) * 0.4;
        float hz = vnoise(vec3((p + vec2(0.0, e)) * 0.09, t * 0.25));
        vec3 n = normalize(vec3(h0 - hx, e * 1.4, h0 - hz));
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
        col = mix(col, vec3(0.60, 0.78, 0.94), fresnel * 0.3);

        // Drifting crest streaks: thin white arcs, stretched along the shore.
        // The noise domain is rotated and layered so nothing lines up on a grid.
        // Cartoon wave lines: thin wavy strokes running along the shore,
        // warped by noise and broken into dashes so they never tile.
        mat2 rot = mat2(0.96, -0.28, 0.28, 0.96);
        vec2 q = rot * p;
        float warp = fbm(vec3(q * 0.02, t * 0.08)) * 9.0;
        float line = sin(q.y * 0.22 + warp - t * 1.2);
        float dash = smoothstep(0.42, 0.5, fbm(vec3(q * 0.05 + 30.0, t * 0.12)));
        float streak = smoothstep(0.90, 0.94, line) * dash;
        col = mix(col, vec3(0.93, 0.98, 1.0), streak * 0.75);

        // Foam: a lacy line where the water meets the sand, breathing in and
        // out, with scattered flecks through the shallows.
        float lace = (vnoise(vec3(p * 0.16, t * 0.5)) - 0.5) * 1.8 + sin(t * 1.1 + p.x * 0.02) * 0.45;
        float foamEdge = 1.3 + lace;
        float foam = 1.0 - smoothstep(foamEdge - 0.5, foamEdge, depth);
        float flecks = smoothstep(0.56, 0.6, fbm(vec3(rot * p * 0.09, t * 0.3 + 9.0)));
        foam = max(foam, flecks * (1.0 - smoothstep(3.0, 3.4, depth)) * 0.8);
        col = mix(col, vec3(0.97, 0.99, 1.0), foam);

        // Hard sun glints.
        vec3 refl = reflect(-viewDir, n);
        float spec = pow(max(dot(refl, uSun), 0.0), 260.0);
        col += vec3(1.0, 0.98, 0.9) * smoothstep(0.25, 0.32, spec) * 0.7;

        // Cel light on the surface so the swell reads as drawn bands.
        col *= 0.88 + 0.22 * celBands(dot(n, uSun));

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
  const hullMat = toon({ color: 0xf3efe6 });
  const trimMat = toon({ color: PAINT.sea });
  const sailMat = toon({ color: 0xffffff, side: DoubleSide });
  boatSpots.forEach(([x, z, heading]) => {
    const boat = new Group();
    const hull = new Mesh(new BoxGeometry(3.2, 1.1, 9), hullMat);
    hull.position.y = 0.3;
    addOutline(hull, 0.09);
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
