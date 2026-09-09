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
/**
 * The swell, shared by the water shader and the boats: three long crossing
 * sines, gentle enough for comfort in VR. `WAVE_GLSL` and `waveHeightAt`
 * below are twins — keep them in step.
 */
const WAVE_GLSL = /* glsl */ `
  float waveHeight(vec2 p, float t) {
    float h = 0.55 * sin(dot(p, vec2(0.045, 0.028)) + t * 0.85);
    h += 0.38 * sin(dot(p, vec2(-0.032, 0.051)) + t * 1.15);
    h += 0.22 * sin(dot(p, vec2(0.071, -0.019)) + t * 1.60);
    return h;
  }
  vec2 waveGradient(vec2 p, float t) {
    vec2 g = vec2(0.045, 0.028) * 0.55 * cos(dot(p, vec2(0.045, 0.028)) + t * 0.85);
    g += vec2(-0.032, 0.051) * 0.38 * cos(dot(p, vec2(-0.032, 0.051)) + t * 1.15);
    g += vec2(0.071, -0.019) * 0.22 * cos(dot(p, vec2(0.071, -0.019)) + t * 1.60);
    return g;
  }
`;

/** JS twin of `waveHeight` — the boats ride the same swell as the shader. */
function waveHeightAt(x: number, z: number, t: number): number {
  let h = 0.55 * Math.sin(x * 0.045 + z * 0.028 + t * 0.85);
  h += 0.38 * Math.sin(x * -0.032 + z * 0.051 + t * 1.15);
  h += 0.22 * Math.sin(x * 0.071 + z * -0.019 + t * 1.6);
  return h;
}

/** JS twin of `waveGradient`, for tilting the boats into the swell. */
function waveGradientAt(x: number, z: number, t: number): [number, number] {
  const c1 = 0.55 * Math.cos(x * 0.045 + z * 0.028 + t * 0.85);
  const c2 = 0.38 * Math.cos(x * -0.032 + z * 0.051 + t * 1.15);
  const c3 = 0.22 * Math.cos(x * 0.071 + z * -0.019 + t * 1.6);
  return [
    0.045 * c1 + -0.032 * c2 + 0.071 * c3,
    0.028 * c1 + 0.051 * c2 + -0.019 * c3
  ];
}

export { waveHeightAt, waveGradientAt };

export function createSea(): SeaHandles {
  const group = new Group();
  const uTime = { value: 0 };

  const makeWaterMaterial = (displace: boolean, halfSpan: number): ShaderMaterial =>
    new ShaderMaterial({
    fog: true,
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime,
        uSun: { value: new Vector3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z) },
        uDisplace: { value: displace ? 1 : 0 },
        uHalfSpan: { value: halfSpan }
      }
    ]),
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      uniform float uTime;
      uniform float uDisplace;
      uniform float uHalfSpan;
      #include <fog_pars_vertex>
      ${LAND_HEIGHT_GLSL}
      ${WAVE_GLSL}
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        // The near plane actually rides the swell. Amplitude tapers to zero
        // at its rim so it meets the flat far ocean without a seam, and in
        // the shallows so the water never pokes up through the beach.
        if (uDisplace > 0.5) {
          float edge = 1.0 - smoothstep(0.72, 0.98, max(abs(position.x), abs(position.y)) / uHalfSpan);
          float shallow = smoothstep(0.5, 6.0, -landHeight(wp.xz));
          wp.y += waveHeight(wp.xz, uTime) * edge * shallow;
        }
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
      ${WAVE_GLSL}

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

        // Surface normal from the same swell the near plane is displaced by,
        // plus a little noise chop — so light and glints travel with the water.
        vec2 grad = waveGradient(p, t);
        float chopE = 0.8;
        float c0 = vnoise(vec3(p * 0.09, t * 0.25));
        float cx = vnoise(vec3((p + vec2(chopE, 0.0)) * 0.09, t * 0.25));
        float cz = vnoise(vec3((p + vec2(0.0, chopE)) * 0.09, t * 0.25));
        vec3 n = normalize(vec3(-grad.x * 1.6 + (c0 - cx), 1.0, -grad.y * 1.6 + (c0 - cz)));
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

  // Far ocean: one flat plane out to the horizon (distant water reads flat).
  const far = new Mesh(new PlaneGeometry(9000, 9000, 1, 1), makeWaterMaterial(false, 4500));
  far.rotation.x = -Math.PI / 2;
  group.add(far);

  // Near water: the stretch you actually look down on, subdivided enough to
  // show a real moving swell. Sits a hair above the far plane to avoid
  // z-fighting where they overlap.
  const NEAR_SPAN = 3000;
  const near = new Mesh(
    new PlaneGeometry(NEAR_SPAN, NEAR_SPAN, 300, 300),
    makeWaterMaterial(true, NEAR_SPAN / 2)
  );
  near.rotation.x = -Math.PI / 2;
  near.position.set(0, 0.02, 900);
  group.add(near);

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
