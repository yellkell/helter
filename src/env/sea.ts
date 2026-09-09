import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3
} from '@iwsdk/core';

import { PAINT, SUN_DIR } from '../constants.js';
import { addOutline, LIGHT_GLSL, NOISE_TEX_GLSL, noiseUniform, toon } from './fx.js';
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

/** Height of the water surface (metres); the land's zero is dry. */
export const SEA_LEVEL = -0.5;

/**
 * A flat square of side 2·`half` in the XZ plane, normals up, with a
 * rectangular hole [x0, x1] × [z0, z1] cut out of it: eight triangles.
 */
function makeFrame(half: number, x0: number, x1: number, z0: number, z1: number): BufferGeometry {
  const corners = [
    [-half, -half], [half, -half], [half, half], [-half, half], // outer 0..3
    [x0, z0], [x1, z0], [x1, z1], [x0, z1] // inner 4..7
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  corners.forEach(([x, z]) => {
    positions.push(x, 0, z);
    normals.push(0, 1, 0);
  });
  const indices: number[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    // Wound so the faces look up (+Y): clockwise as seen from above in XZ.
    indices.push(i, i + 4, j, j, i + 4, j + 4);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

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

  const makeWaterMaterial = (displace: boolean, halfSpan: number): ShaderMaterial => {
    const uniforms = UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime,
        uSun: { value: new Vector3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z) },
        uDisplace: { value: displace ? 1 : 0 },
        uHalfSpan: { value: halfSpan }
      }
    ]);
    uniforms.uNoise = noiseUniform();
    return new ShaderMaterial({
    fog: true,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying float vDepth;
      uniform float uTime;
      uniform float uDisplace;
      uniform float uHalfSpan;
      #include <fog_pars_vertex>
      ${LAND_HEIGHT_GLSL}
      ${WAVE_GLSL}
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        // Water depth is found here, per vertex (the near plane's 10 m grid
        // resolves the coast fine); the fragment shader only recomputes it
        // exactly in the shallows, where the foam line needs it. The far
        // plane is deep ocean everywhere it shows.
        float depth = 30.0;
        // The near plane actually rides the swell. Amplitude tapers to zero
        // at its rim so it meets the flat far ocean without a seam, and in
        // the shallows so the water never pokes up through the beach.
        if (uDisplace > 0.5) {
          depth = -landHeight(wp.xz);
          float edge = 1.0 - smoothstep(0.72, 0.98, max(abs(position.x), abs(position.y)) / uHalfSpan);
          float shallow = smoothstep(0.5, 6.0, depth);
          wp.y += waveHeight(wp.xz, uTime) * edge * shallow;
        }
        vDepth = depth;
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying float vDepth;
      uniform float uTime;
      uniform vec3 uSun;
      #include <fog_pars_fragment>
      ${NOISE_TEX_GLSL}
      ${LIGHT_GLSL}
      ${LAND_HEIGHT_GLSL}
      ${WAVE_GLSL}

      void main() {
        vec2 p = vWorld.xz;
        float t = uTime;
        // Metres of water under this point: exact near the beach, where the
        // colour bands and the foam edge live; interpolated out at sea.
        float depth = vDepth < 16.0 ? -landHeight(p) : vDepth;

        // Flat colour bands by depth.
        vec3 shallow = vec3(0.22, 0.72, 0.68);
        vec3 mid = vec3(0.06, 0.42, 0.62);
        vec3 deep = vec3(0.02, 0.20, 0.44);
        vec3 col = deep;
        col = mix(col, mid, 1.0 - smoothstep(9.0, 11.0, depth));
        col = mix(col, shallow, 1.0 - smoothstep(2.6, 3.4, depth));

        // Surface normal from the same swell the near plane is displaced by,
        // plus a little drifting noise chop — so light and glints travel
        // with the water. (All the noise here is baked: one lookup each.)
        vec2 grad = waveGradient(p, t);
        vec2 cp = p * 0.09 + vec2(t * 0.02, t * 0.013);
        float c0 = noiseTex(cp);
        float cx = noiseTex(cp + vec2(0.072, 0.0));
        float cz = noiseTex(cp + vec2(0.0, 0.072));
        vec3 n = normalize(vec3(-grad.x * 1.6 + (c0 - cx), 1.0, -grad.y * 1.6 + (c0 - cz)));
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
        col = mix(col, vec3(0.60, 0.78, 0.94), fresnel * 0.3);

        // Cartoon wave lines: thin wavy strokes running along the shore,
        // warped by noise and broken into dashes so they never tile. The
        // noise domain is rotated so nothing lines up on a grid.
        mat2 rot = mat2(0.96, -0.28, 0.28, 0.96);
        vec2 q = rot * p;
        float warp = fbmTex(q * 0.02 + vec2(t * 0.004, 0.0)) * 9.0;
        float line = sin(q.y * 0.22 + warp - t * 1.2);
        float dash = smoothstep(0.42, 0.5, fbmTexB(q * 0.05 + vec2(t * 0.006, t * 0.0025)));
        float streak = smoothstep(0.90, 0.94, line) * dash;
        col = mix(col, vec3(0.93, 0.98, 1.0), streak * 0.75);

        // Foam: a lacy line where the water meets the sand, breathing in and
        // out, with scattered flecks through the shallows.
        float lace = (noiseTexB(p * 0.16 + vec2(t * 0.06, 0.0)) - 0.5) * 1.8 + sin(t * 1.1 + p.x * 0.02) * 0.45;
        float foamEdge = 1.3 + lace;
        float foam = 1.0 - smoothstep(foamEdge - 0.5, foamEdge, depth);
        float flecks = smoothstep(0.56, 0.6, fbmTexB(rot * p * 0.09 + vec2(9.0 + t * 0.03, 0.0)));
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
  };

  // The whole sea sits half a metre below the land's zero. The plaza and
  // the meadow floor are flattened to exactly 0, and water at 0 under them
  // fought the ground for the depth buffer — a flicker straight down from
  // the balcony. Nothing on the beach reads the difference.
  group.position.y = SEA_LEVEL;

  // Near water: the stretch you actually look down on, subdivided enough to
  // show a real moving swell.
  const NEAR_SPAN = 3000;
  const NEAR_Z = 900;
  const nearMaterial = makeWaterMaterial(true, NEAR_SPAN / 2);
  // Where the shore shelves under it the water is nearly coplanar with the
  // sand; nudging the water toward the camera in depth settles which one
  // wins, so the waterline no longer shimmers from up the tower.
  nearMaterial.polygonOffset = true;
  nearMaterial.polygonOffsetFactor = -1;
  nearMaterial.polygonOffsetUnits = -2;
  const near = new Mesh(new PlaneGeometry(NEAR_SPAN, NEAR_SPAN, 300, 300), nearMaterial);
  near.rotation.x = -Math.PI / 2;
  near.position.set(0, 0, NEAR_Z);
  group.add(near);

  // Far ocean: a flat frame around the near water out to the horizon
  // (distant water reads flat). It used to be a full plane under the near
  // one, a hair lower, and the two fought wherever they overlapped.
  group.add(new Mesh(makeFrame(4500, -NEAR_SPAN / 2, NEAR_SPAN / 2, NEAR_Z - NEAR_SPAN / 2, NEAR_Z + NEAR_SPAN / 2), makeWaterMaterial(false, 4500)));

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
