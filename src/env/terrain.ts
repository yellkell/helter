import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3
} from '@iwsdk/core';

import { addOutline, LIGHT_GLSL, mergeGeometries, mulberry32, NOISE_GLSL, toon } from './fx.js';

export interface TerrainHandles {
  group: Group;
  /** Height of the land at (x, z) — the same function the mesh was built from. */
  heightAt: (x: number, z: number) => number;
}

/** Extent of the land mesh (the sea plane is larger and sits under it). */
const SIZE = 5200;
const SEGMENTS = 288;
/** Where the coastal green starts shelving down to the beach (+Z is seaward). */
export const SHORE_Z = 230;
const PLAZA_RADIUS = 110;

// Tiny JS value noise; the GLSL twin below must match it term for term so the
// sea can find the shoreline the land mesh was built from.
function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x: number, y: number, octaves = 5): number {
  let v = 0;
  let amp = 0.5;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    v += amp * vnoise(fx, fy);
    fx = fx * 2.03 + 17.3;
    fy = fy * 2.03 + 9.1;
    amp *= 0.5;
  }
  return v;
}
function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * The coast the tower stands on. A broad, level green the fair sits on;
 * seaward (+Z) it shelves to a sandy beach and under the water; inland (−Z)
 * the downs rise into a ridge. Land never dips below sea level inland —
 * a floor keeps the meadows dry — so the only water is the sea.
 */
function heightAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  let h = 4 - 7 * smooth(SHORE_Z, SHORE_Z + 90, z);
  h += (fbm(x * 0.012 + 5, z * 0.012, 3) - 0.5) * 3.2;
  const hills = (fbm(x * 0.0009 + 3.1, z * 0.0009 - 1.7, 5) * 2 - 1) * 70 + 40;
  const knolls = (fbm(x * 0.004, z * 0.004, 4) - 0.5) * 26;
  const inlandAmp = smooth(220, 900, -z);
  h += (hills + knolls) * inlandAmp;
  const ridge = Math.max(0, -z - 600) / 1800;
  h += ridge * ridge * 420 + ridge * 60;
  const seaward = Math.max(0, z - (SHORE_Z + 100)) / 220;
  h -= seaward * seaward * 45 + seaward * 14;
  h = Math.max(h, -60);
  // Dry land: nothing inland sits below 2m, so there are no puddles. The
  // floor drops away across the beach so the shore itself is untouched.
  h = Math.max(h, 2.0 - 80 * smooth(SHORE_Z, SHORE_Z + 70, z));
  // Flatten the fairground plaza; the blend keeps a soft rim of grass.
  const plaza = 1 - smooth(PLAZA_RADIUS, PLAZA_RADIUS * 1.9, r);
  h = h * (1 - plaza);
  return h;
}

/**
 * GLSL twin of the coastal part of `heightAt` (the terms that matter within
 * a few hundred metres of the shore). The sea shader uses it for depth.
 */
export const LAND_HEIGHT_GLSL = /* glsl */ `
  float hashT(vec2 p) { return fract(sin(p.x * 127.1 + p.y * 311.7) * 43758.5453); }
  float vnoiseT(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hashT(i);
    float b = hashT(i + vec2(1.0, 0.0));
    float c = hashT(i + vec2(0.0, 1.0));
    float d = hashT(i + vec2(1.0, 1.0));
    return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
  }
  float fbmT3(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 3; i++) {
      v += amp * vnoiseT(p);
      p = p * 2.03 + vec2(17.3, 9.1);
      amp *= 0.5;
    }
    return v;
  }
  float landHeight(vec2 xz) {
    float z = xz.y;
    float h = 4.0 - 7.0 * smoothstep(${SHORE_Z.toFixed(1)}, ${(SHORE_Z + 90).toFixed(1)}, z);
    h += (fbmT3(vec2(xz.x * 0.012 + 5.0, z * 0.012)) - 0.5) * 3.2;
    float sw = max(0.0, z - ${(SHORE_Z + 100).toFixed(1)}) / 220.0;
    h -= sw * sw * 45.0 + sw * 14.0;
    return h;
  }
`;

/**
 * Cartoon land: flat colour bands picked in the fragment shader — wet sand,
 * sand, grass with darker copse patches and lighter meadow, rock on steep
 * faces, snow on the ridge — lit in cel bands and fogged.
 */
function createLandMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    fog: true,
    uniforms: UniformsUtils.merge([UniformsLib.fog, {}]),
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      ${LIGHT_GLSL}
      void main() {
        float y = vWorld.y;
        vec3 n = normalize(vNormal);
        vec3 sand = vec3(0.86, 0.72, 0.40);
        vec3 wetSand = vec3(0.56, 0.46, 0.28);
        vec3 grass = vec3(0.20, 0.56, 0.12);
        vec3 grassDark = vec3(0.11, 0.38, 0.10);
        vec3 meadow = vec3(0.40, 0.68, 0.14);
        vec3 rock = vec3(0.40, 0.42, 0.48);
        vec3 snow = vec3(0.92, 0.94, 1.0);

        // Grass with hard-edged copse patches and meadow patches.
        float copse = fbm(vec3(vWorld.xz * 0.012, 3.0));
        float light = fbm(vec3(vWorld.xz * 0.005 + 40.0, 7.0));
        vec3 col = grass;
        col = mix(col, meadow, smoothstep(0.55, 0.57, light));
        col = mix(col, grassDark, smoothstep(0.57, 0.59, copse));

        // The beach: only seaward of the green, never around the plaza.
        float seaward = smoothstep(${(SHORE_Z - 40).toFixed(1)}, ${(SHORE_Z - 15).toFixed(1)}, vWorld.z);
        col = mix(col, sand, (1.0 - smoothstep(1.7, 2.1, y)) * seaward);
        col = mix(col, wetSand, (1.0 - smoothstep(0.15, 0.5, y)) * seaward);

        // Steep faces show rock; the ridge top is snow.
        float slope = 1.0 - n.y;
        col = mix(col, rock, smoothstep(0.30, 0.36, slope) * smoothstep(20.0, 40.0, y));
        col = mix(col, snow, smoothstep(360.0, 400.0, y));

        gl_FragColor = vec4(shade(col, n), 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `
  });
}

export function createTerrain(): TerrainHandles {
  const group = new Group();

  const geometry = new PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  }
  geometry.computeVertexNormals();
  group.add(new Mesh(geometry, createLandMaterial()));

  group.add(createTrees());
  return { group, heightAt };
}

/**
 * Cartoon woodland: two-tier pines on the downs and faceted round trees
 * across the coastal green, both instanced, toon-lit and ink-outlined.
 */
function createTrees(): Group {
  const group = new Group();
  const rnd = mulberry32(2024);

  const m = new Matrix4();
  const q = new Quaternion();
  const p = new Vector3();
  const s = new Vector3();
  const yAxis = new Vector3(0, 1, 0);
  const color = new Color();

  // --- Pines ---------------------------------------------------------------
  const lower = new ConeGeometry(1, 0.62, 7, 1);
  lower.translate(0, 0.31, 0);
  const upper = new ConeGeometry(0.68, 0.6, 7, 1);
  upper.translate(0, 0.72, 0);
  const pineGeo = mergeGeometries([lower, upper]);
  const trunkGeo = new CylinderGeometry(0.12, 0.16, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const PINES = 900;
  const pines = new InstancedMesh(pineGeo, toon({ color: 0xffffff }), PINES);
  const pineTrunks = new InstancedMesh(trunkGeo, toon({ color: 0x5a3e2a }), PINES);
  const pinePalette = [0x2e7d3a, 0x3c8f3f, 0x27703a, 0x4a9a44];

  let placed = 0;
  let tries = 0;
  while (placed < PINES && tries < PINES * 30) {
    tries++;
    const x = (rnd() - 0.5) * 3600;
    const z = -140 - rnd() * 2400 + (rnd() - 0.5) * 200;
    if (Math.hypot(x, z) < PLAZA_RADIUS * 2.2) continue;
    const h = heightAt(x, z);
    if (h < 3 || h > 240) continue;
    if (fbm(x * 0.0025 + 9, z * 0.0025, 3) < 0.5) continue; // copses

    const height = 8 + rnd() * 9;
    const width = height * (0.42 + rnd() * 0.14);
    q.setFromAxisAngle(yAxis, rnd() * Math.PI * 2);
    p.set(x, h + height * 0.2, z);
    s.set(width, height * 0.8, width);
    m.compose(p, q, s);
    pines.setMatrixAt(placed, m);
    color.setHex(pinePalette[Math.floor(rnd() * pinePalette.length)]);
    pines.setColorAt(placed, color);
    p.set(x, h - 0.5, z);
    s.set(width * 0.16, height * 0.3, width * 0.16);
    m.compose(p, q, s);
    pineTrunks.setMatrixAt(placed, m);
    placed++;
  }
  pines.count = placed;
  pineTrunks.count = placed;
  addOutline(pines, 0.035);
  addOutline(pineTrunks, 0.08);
  group.add(pines, pineTrunks);

  // --- Round trees on the green ----------------------------------------------
  const ballGeo = new IcosahedronGeometry(1, 1);
  const ROUND = 260;
  const balls = new InstancedMesh(ballGeo, toon({ color: 0xffffff }), ROUND);
  const ballTrunks = new InstancedMesh(trunkGeo, toon({ color: 0x6b4a33 }), ROUND);
  const roundPalette = [0x5fae3c, 0x7cc244, 0x4a9a3b, 0x9ccb4a];
  placed = 0;
  tries = 0;
  while (placed < ROUND && tries < ROUND * 40) {
    tries++;
    const x = (rnd() - 0.5) * 1500;
    const z = -420 + rnd() * 640;
    const r = Math.hypot(x, z);
    if (r < PLAZA_RADIUS * 1.35 || r > 780) continue;
    const h = heightAt(x, z);
    if (h < 2.4) continue;
    if (fbm(x * 0.006 + 3, z * 0.006, 3) < 0.48) continue;

    const height = 5 + rnd() * 5;
    const radius = height * (0.42 + rnd() * 0.12);
    q.setFromAxisAngle(yAxis, rnd() * Math.PI * 2);
    p.set(x, h + height * 0.62, z);
    s.set(radius, radius * 0.95, radius);
    m.compose(p, q, s);
    balls.setMatrixAt(placed, m);
    color.setHex(roundPalette[Math.floor(rnd() * roundPalette.length)]);
    balls.setColorAt(placed, color);
    p.set(x, h - 0.4, z);
    s.set(radius * 0.22, height * 0.5, radius * 0.22);
    m.compose(p, q, s);
    ballTrunks.setMatrixAt(placed, m);
    placed++;
  }
  balls.count = placed;
  ballTrunks.count = placed;
  addOutline(balls, 0.05);
  addOutline(ballTrunks, 0.09);
  group.add(balls, ballTrunks);

  return group;
}
