import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3
} from '@iwsdk/core';

import { mulberry32 } from './fx.js';

export interface TerrainHandles {
  group: Group;
  /** Height of the land at (x, z) — the same function the mesh was built from. */
  heightAt: (x: number, z: number) => number;
}

/** Extent of the land mesh (the sea plane is larger and sits under it). */
const SIZE = 5200;
const SEGMENTS = 224;
/** Where the beach starts (+Z is seaward) and how far inland it stays flat. */
const SHORE_Z = 300;
const PLAZA_RADIUS = 110;

// Tiny JS value noise (matches the GLSL one in spirit; only used at build).
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

/**
 * The coast the tower stands on. Rolling green downs rise inland (−Z) into a
 * ridge of chalky hills; seaward (+Z) the land drops to a sandy beach and
 * dips under the water. A flat paved plaza around the tower keeps the
 * fairground level.
 */
function heightAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  // A broad, nearly level coastal green the fair sits on: a touch above the
  // sea inland, shelving to the beach seaward (+Z).
  let h = 4 - 7 * smooth(100, 330, z);
  // Dunes and meadow undulation.
  h += (fbm(x * 0.012 + 5, z * 0.012, 3) - 0.5) * 3.2;
  // The downs rise inland, then the ridge.
  const hills = (fbm(x * 0.0009 + 3.1, z * 0.0009 - 1.7, 5) * 2 - 1) * 70 + 40;
  const knolls = (fbm(x * 0.004, z * 0.004, 4) - 0.5) * 26;
  const inlandAmp = smooth(220, 900, -z);
  h += (hills + knolls) * inlandAmp;
  const ridge = Math.max(0, -z - 600) / 1800;
  h += ridge * ridge * 420 + ridge * 60;
  // Seaward: shelve down into the water past the shore line.
  const seaward = Math.max(0, z - SHORE_Z) / 220;
  h -= seaward * seaward * 45 + seaward * 14;
  h = Math.max(h, -60);
  // Flatten the fairground plaza; the blend keeps a soft rim of grass.
  const plaza = 1 - smooth(PLAZA_RADIUS, PLAZA_RADIUS * 1.9, r);
  h = h * (1 - plaza);
  return h;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function createTerrain(): TerrainHandles {
  const group = new Group();

  const geometry = new PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
  geometry.rotateX(-Math.PI / 2); // XZ plane, +Y up
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  const sand = new Color(0xd9c59a);
  const wetSand = new Color(0xb8a27a);
  const grass = new Color(0x4f8a3a);
  const grassDark = new Color(0x2f6a2c);
  const meadow = new Color(0x89a84a);
  const chalk = new Color(0xc9c4b2);
  const rock = new Color(0x7c7a72);
  const paving = new Color(0x9a948c);
  const c = new Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = heightAt(x, z);
    pos.setY(i, h);

    const r = Math.hypot(x, z);
    const n = fbm(x * 0.02, z * 0.02, 3);
    if (r < PLAZA_RADIUS * 1.05) {
      c.copy(paving).offsetHSL(0, 0, (n - 0.5) * 0.06);
    } else if (h < 1.2) {
      c.lerpColors(wetSand, sand, smooth(-3, 1.2, h));
    } else if (h < 5) {
      c.lerpColors(sand, meadow, smooth(1.2, 5, h));
    } else {
      c.lerpColors(grass, grassDark, 0.35 + (n - 0.5) * 0.5);
      c.lerp(meadow, (fbm(x * 0.0035 + 40, z * 0.0035, 3) - 0.5) * 0.5 + 0.25);
      c.offsetHSL(0, 0, (fbm(x * 0.03, z * 0.03, 2) - 0.5) * 0.05);
      // Exposed chalk and rock only on the high ridge.
      c.lerp(chalk, smooth(210, 330, h) * 0.55);
      c.lerp(rock, smooth(330, 460, h) * 0.7);
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const land = new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true }));
  group.add(land);

  group.add(createTrees());

  return { group, heightAt };
}

/**
 * Woodland on the downs: two instanced meshes (canopy + trunk), scattered by
 * a seeded PRNG onto grass that's high enough to be dry and far enough from
 * the plaza to leave the fair open.
 */
function createTrees(): Group {
  const group = new Group();
  const rnd = mulberry32(2024);
  const COUNT = 1100;

  const canopyGeo = new ConeGeometry(1, 1, 7, 1);
  canopyGeo.translate(0, 0.5, 0);
  const trunkGeo = new CylinderGeometry(0.12, 0.18, 1, 5);
  trunkGeo.translate(0, 0.5, 0);
  const canopy = new InstancedMesh(canopyGeo, new MeshLambertMaterial({ color: 0xffffff }), COUNT);
  const trunk = new InstancedMesh(trunkGeo, new MeshLambertMaterial({ color: 0x5a3e2a }), COUNT);

  const m = new Matrix4();
  const q = new Quaternion();
  const p = new Vector3();
  const s = new Vector3();
  const color = new Color();
  const palette = [0x2e6b2f, 0x3d7d33, 0x4f8f3a, 0x27592a, 0x62933b];

  let placed = 0;
  let tries = 0;
  while (placed < COUNT && tries < COUNT * 30) {
    tries++;
    const x = (rnd() - 0.5) * 3600;
    const z = -120 - rnd() * 2400 + (rnd() - 0.5) * 200;
    const r = Math.hypot(x, z);
    if (r < PLAZA_RADIUS * 2.2) continue;
    const h = heightAt(x, z);
    if (h < 3.2 || h > 240) continue;
    // Clump into copses.
    if (fbm(x * 0.0025 + 9, z * 0.0025, 3) < 0.5) continue;

    const height = 7 + rnd() * 9;
    const width = height * (0.36 + rnd() * 0.16);
    q.setFromAxisAngle(new Vector3(0, 1, 0), rnd() * Math.PI * 2);

    p.set(x, h + height * 0.22, z);
    s.set(width, height * 0.85, width);
    m.compose(p, q, s);
    canopy.setMatrixAt(placed, m);
    color.setHex(palette[Math.floor(rnd() * palette.length)]).offsetHSL(0, 0, (rnd() - 0.5) * 0.08);
    canopy.setColorAt(placed, color);

    p.set(x, h - 0.5, z);
    s.set(width * 0.18, height * 0.3, width * 0.18);
    m.compose(p, q, s);
    trunk.setMatrixAt(placed, m);
    placed++;
  }
  canopy.count = placed;
  trunk.count = placed;
  group.add(canopy, trunk);
  return group;
}
