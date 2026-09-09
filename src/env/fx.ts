import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  CanvasTexture,
  Color,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  Float32BufferAttribute,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  type MeshToonMaterialParameters,
  NearestFilter,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Texture,
  UniformsLib,
  UniformsUtils,
  Vector3
} from '@iwsdk/core';

import { PAINT, SUN_DIR } from '../constants.js';

let glowTexture: Texture | null = null;

/** Deterministic PRNG so the world is identical every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Soft radial glow sprite texture, generated once on a canvas. */
export function getGlowTexture(): Texture {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowTexture = new CanvasTexture(canvas);
  return glowTexture;
}

/** Additive glow sprite — used sparingly in daylight (the sun, the finial). */
export function makeGlow(color: number | string, scale: number, opacity = 1): Sprite {
  const material = new SpriteMaterial({
    map: getGlowTexture(),
    color: new Color(color),
    blending: AdditiveBlending,
    transparent: true,
    opacity,
    depthWrite: false
  });
  const sprite = new Sprite(material);
  sprite.scale.setScalar(scale);
  return sprite;
}

/**
 * Diagonal candy stripes on a canvas — the gates and the tents wear these.
 * Baked so it mipmaps cleanly instead of shimmering at distance in VR.
 */
export function makeStripeTexture(
  colorA: string,
  colorB: string,
  stripes = 6,
  diagonal = true
): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = colorA;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = colorB;
  const w = size / stripes;
  if (diagonal) {
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(-Math.PI / 4);
    ctx.translate(-size, -size);
    for (let i = 0; i < stripes * 3; i += 2) {
      ctx.fillRect(i * w, 0, w, size * 3);
    }
    ctx.restore();
  } else {
    for (let i = 0; i < stripes; i += 2) ctx.fillRect(i * w, 0, w, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Painted signboard text on a transparent canvas. */
export function makeTextTexture(
  text: string,
  opts?: { color?: string; background?: string; width?: number; height?: number; border?: string }
): CanvasTexture {
  const width = opts?.width ?? 1024;
  const height = opts?.height ?? 256;
  const color = opts?.color ?? '#1a1614';
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);
  if (opts?.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, width, height);
  }
  if (opts?.border) {
    ctx.strokeStyle = opts.border;
    ctx.lineWidth = height * 0.06;
    ctx.strokeRect(height * 0.05, height * 0.05, width - height * 0.1, height * 0.9);
  }
  ctx.font = `900 ${Math.floor(height * 0.5)}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, width / 2, height / 2 + height * 0.02, width * 0.9);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// ---------------------------------------------------------------------------
// Baked noise. The painted shaders used to evaluate four octaves of value
// noise per fragment — dozens of hash calls for every pixel of sky, sea and
// land, which is most of the view in a headset. The same noise is now baked
// once into a small tileable texture and read with one lookup.
// ---------------------------------------------------------------------------

const NOISE_SIZE = 256;
/** Lattice cells per tile in the base octave of the baked fbm (R and G). */
const FBM_CELLS = 4;
/** Lattice cells per tile in the single-octave channels (B and A). */
const NOISE_CELLS = 8;

let noiseTexture: DataTexture | null = null;

function latticeHash(ix: number, iy: number, seed: number): number {
  const s = Math.sin(ix * 127.1 + iy * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Value noise on a lattice of `cells` per unit of (u, v), wrapped so it tiles. */
function tileNoise(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells;
  const y = v * cells;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % cells) + cells) % cells;
  const y0 = ((iy % cells) + cells) % cells;
  const x1 = (x0 + 1) % cells;
  const y1 = (y0 + 1) % cells;
  const a = latticeHash(x0, y0, seed);
  const b = latticeHash(x1, y0, seed);
  const c = latticeHash(x0, y1, seed);
  const d = latticeHash(x1, y1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/**
 * 256² RGBA noise that tiles seamlessly:
 * R, G — two independent four-octave fbms (mean ≈ 0.47, the same
 *        distribution as the old shader fbm, so its thresholds still hold);
 * B, A — two independent single-octave value noises.
 */
export function getNoiseTexture(): DataTexture {
  if (noiseTexture) return noiseTexture;
  const size = NOISE_SIZE;
  const data = new Uint8Array(size * size * 4);
  const fbm = (u: number, v: number, seed: number): number => {
    let value = 0;
    let amp = 0.5;
    let cells = FBM_CELLS;
    for (let o = 0; o < 4; o++) {
      value += amp * tileNoise(u, v, cells, seed + o * 13);
      cells *= 2;
      amp *= 0.5;
    }
    return value;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const o = (y * size + x) * 4;
      data[o] = Math.round(fbm(u, v, 1) * 255);
      data[o + 1] = Math.round(fbm(u, v, 101) * 255);
      data[o + 2] = Math.round(tileNoise(u, v, NOISE_CELLS, 7) * 255);
      data[o + 3] = Math.round(tileNoise(u, v, NOISE_CELLS, 57) * 255);
    }
  }
  noiseTexture = new DataTexture(data, size, size, RGBAFormat);
  noiseTexture.wrapS = RepeatWrapping;
  noiseTexture.wrapT = RepeatWrapping;
  noiseTexture.magFilter = LinearFilter;
  noiseTexture.minFilter = LinearMipmapLinearFilter;
  noiseTexture.generateMipmaps = true;
  noiseTexture.needsUpdate = true;
  return noiseTexture;
}

let woodTexture: CanvasTexture | null = null;

/** Metres of slide one repeat of the wood texture covers, across and along. */
export const WOOD_TILE = 2.4;

/**
 * Varnished timber for the slide bed and the landing bays: six boards
 * across the tile, staggered end joints, a slow grain running along the
 * boards, a knot or two, dark seams. Tiles seamlessly; 2.4 m square.
 */
export function getWoodTexture(): CanvasTexture {
  if (woodTexture) return woodTexture;
  const size = 512;
  const planks = 6;
  const plankW = size / planks;
  const rnd = mulberry32(31);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const px = image.data;

  // Per-board tone and where along the tile its end joint falls.
  const tones: number[] = [];
  const joints: number[] = [];
  for (let c = 0; c < planks; c++) {
    tones.push(0.9 + rnd() * 0.2);
    joints.push(Math.floor(rnd() * size));
  }
  const knots = [
    { x: rnd() * size, y: rnd() * size, r: 5 + rnd() * 6 },
    { x: rnd() * size, y: rnd() * size, r: 4 + rnd() * 5 }
  ];
  const base = [226, 178, 118]; // honey pine, sRGB

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = Math.floor(x / plankW);
      // The board past the joint is a different board: its own tone.
      const beyond = ((y - joints[c] + size) % size) < size / 2 ? 0 : 1;
      let tone = tones[(c + beyond * 3) % planks];
      // Grain: long lines along the board, wobbling slowly, plus broad
      // colour drift so no two patches match.
      const u = x / size;
      const v = y / size;
      const wobble = tileNoise(u, v, 3, 5 + c) * 9.0 + tileNoise(u, v, 12, 9) * 2.0;
      const line = 0.5 + 0.5 * Math.sin(x * 0.55 + wobble + c * 17);
      tone *= 1 - 0.16 * Math.pow(line, 5);
      tone *= 1 + (tileNoise(u, v, 4, 21) - 0.5) * 0.22;
      // Knots: dark rings.
      for (const k of knots) {
        const d = Math.hypot((x - k.x) * 1.6, y - k.y);
        if (d < k.r * 2.2) tone *= 0.72 + 0.28 * (0.5 + 0.5 * Math.cos(d * 1.4));
      }
      // Seams between boards and at the end joints.
      const seamX = Math.min(x % plankW, plankW - (x % plankW));
      if (seamX < 1.5) tone *= 0.55;
      else if (seamX < 3) tone *= 0.8;
      const seamY = Math.min((y - joints[c] + size) % size, (joints[c] - y + size) % size);
      if (seamY < 1.5) tone *= 0.6;
      const o = (y * size + x) * 4;
      px[o] = Math.min(255, base[0] * tone);
      px[o + 1] = Math.min(255, base[1] * tone);
      px[o + 2] = Math.min(255, base[2] * tone);
      px[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  woodTexture = new CanvasTexture(canvas);
  woodTexture.wrapS = RepeatWrapping;
  woodTexture.wrapT = RepeatWrapping;
  woodTexture.colorSpace = SRGBColorSpace;
  woodTexture.anisotropy = 8;
  return woodTexture;
}

/** The `uNoise` uniform. Add it after `UniformsUtils.merge`, which would clone the texture. */
export function noiseUniform(): { value: DataTexture } {
  return { value: getNoiseTexture() };
}

/**
 * Shared GLSL: texture-backed noise. `fbmTex(p)` stands in for the old
 * `fbm(vec3(p, k))` — one lattice cell per unit of `p`, same value range —
 * and `noiseTex(p)` for a single `vnoise`. The B variants are independent
 * patterns for when two layers must not line up.
 */
export const NOISE_TEX_GLSL = /* glsl */ `
  uniform sampler2D uNoise;
  float fbmTex(vec2 p) { return texture2D(uNoise, p * ${(1 / FBM_CELLS).toFixed(6)}).r; }
  float fbmTexB(vec2 p) { return texture2D(uNoise, p * ${(1 / FBM_CELLS).toFixed(6)}).g; }
  float noiseTex(vec2 p) { return texture2D(uNoise, p * ${(1 / NOISE_CELLS).toFixed(6)}).b; }
  float noiseTexB(vec2 p) { return texture2D(uNoise, p * ${(1 / NOISE_CELLS).toFixed(6)}).a; }
`;

/** Shared GLSL: a cheap hash for per-cell variation (the paving uses it). */
export const NOISE_GLSL = /* glsl */ `
  float hash13(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
`;

/**
 * Shared GLSL: cel lighting for the custom painted materials. Sunlight is
 * quantised into three flat bands (lit / half / shadow) with a crisp edge,
 * matching the toon gradient the standard meshes use, so the shader-built
 * tower, slide, sea and land read as one drawing. Colours are linear.
 */
export const LIGHT_GLSL = /* glsl */ `
  const vec3 SUN_DIR = vec3(${SUN_DIR.x.toFixed(4)}, ${SUN_DIR.y.toFixed(4)}, ${SUN_DIR.z.toFixed(4)});
  const vec3 SUN_COL = vec3(1.0, 0.95, 0.86) * 0.95;
  const vec3 SKY_COL = vec3(0.50, 0.66, 0.90) * 0.55;
  const vec3 GROUND_COL = vec3(0.36, 0.40, 0.32) * 0.45;
  float celBands(float ndl) {
    float a = smoothstep(0.02, 0.06, ndl);
    float b = smoothstep(0.42, 0.46, ndl);
    return 0.10 + a * 0.45 + b * 0.45;
  }
  vec3 shade(vec3 albedo, vec3 n) {
    float ndl = dot(n, SUN_DIR);
    float hemi = n.y * 0.5 + 0.5;
    vec3 ambient = mix(GROUND_COL, SKY_COL, hemi);
    return albedo * (SUN_COL * celBands(ndl) + ambient);
  }
`;

// ---------------------------------------------------------------------------
// Toon materials + ink outlines — the cel-shaded look for standard meshes.
// ---------------------------------------------------------------------------

let gradientMap: DataTexture | null = null;

/** Three flat lighting steps for MeshToonMaterial, shared by every toon mesh. */
export function getGradientMap(): DataTexture {
  if (gradientMap) return gradientMap;
  const steps = [0.28, 0.62, 1.0];
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = Math.round(v * 255);
    data[i * 4 + 3] = 255;
  });
  gradientMap = new DataTexture(data, steps.length, 1, RGBAFormat);
  gradientMap.minFilter = NearestFilter;
  gradientMap.magFilter = NearestFilter;
  gradientMap.generateMipmaps = false;
  gradientMap.needsUpdate = true;
  return gradientMap;
}

/** A MeshToonMaterial with the shared gradient — the default for solid props. */
export function toon(params: MeshToonMaterialParameters = {}): MeshToonMaterial {
  return new MeshToonMaterial({ gradientMap: getGradientMap(), ...params });
}

const outlineMaterials = new Map<number, ShaderMaterial>();

/**
 * Ink outline material: back faces pushed out along their normals by
 * `thickness` metres, drawn in flat ink. Works on instanced meshes too.
 */
export function outlineMaterial(thickness: number): ShaderMaterial {
  let material = outlineMaterials.get(thickness);
  if (material) return material;
  material = new ShaderMaterial({
    side: BackSide,
    fog: true,
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      { uThickness: { value: thickness }, uColor: { value: new Color(PAINT.ink) } }
    ]),
    vertexShader: /* glsl */ `
      uniform float uThickness;
      #include <fog_pars_vertex>
      void main() {
        vec3 p = position + normalize(normal) * uThickness;
        #ifdef USE_INSTANCING
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        #else
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        #endif
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      #include <fog_pars_fragment>
      void main() {
        gl_FragColor = vec4(uColor, 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `
  });
  outlineMaterials.set(thickness, material);
  return material;
}

/**
 * Give a mesh an ink outline as a child that shares its geometry (and, for
 * instanced meshes, its instance matrices). Returns the outline so callers
 * that change `count` later can keep it in sync.
 */
export function addOutline(mesh: Mesh | InstancedMesh, thickness: number): Mesh | InstancedMesh {
  const material = outlineMaterial(thickness);
  let outline: Mesh | InstancedMesh;
  if ((mesh as InstancedMesh).isInstancedMesh) {
    const source = mesh as InstancedMesh;
    const inst = new InstancedMesh(source.geometry, material, source.instanceMatrix.count);
    inst.instanceMatrix = source.instanceMatrix;
    inst.count = source.count;
    inst.frustumCulled = source.frustumCulled;
    outline = inst;
  } else {
    outline = new Mesh(mesh.geometry, material);
  }
  outline.name = 'outline';
  mesh.add(outline);
  return outline;
}

/** Concatenate non-indexed geometries with position / normal / uv. */
export function mergeGeometries(parts: BufferGeometry[]): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (const part of parts) {
    const g = part.index ? part.toNonIndexed() : part;
    positions.push(...Array.from(g.attributes.position.array as ArrayLike<number>));
    normals.push(...Array.from(g.attributes.normal.array as ArrayLike<number>));
    const uv = g.attributes.uv;
    if (uv) uvs.push(...Array.from(uv.array as ArrayLike<number>));
    else for (let i = 0; i < g.attributes.position.count; i++) uvs.push(0, 0);
  }
  const merged = new BufferGeometry();
  merged.setAttribute('position', new Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  merged.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return merged;
}

/** Vertex-shader boilerplate: world position, normal, fog, and mvPosition. */
export const LIT_VERTEX_GLSL = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

// ---------------------------------------------------------------------------
// Confetti — DOWN's landing celebration, in seaside colours.
// ---------------------------------------------------------------------------

const CONFETTI_COLORS = [PAINT.red, PAINT.cream, PAINT.gold, PAINT.sea, PAINT.mint, 0xffffff];

interface ConfettiPiece {
  position: Vector3;
  velocity: Vector3;
  rotation: Vector3;
  spin: Vector3;
  wobble: number;
  wobbleSpeed: number;
}

export class Confetti {
  readonly mesh: InstancedMesh;
  private pieces: ConfettiPiece[] = [];
  private active = false;
  private elapsed = 0;
  private readonly matrix = new Matrix4();
  private readonly quaternion = new Quaternion();
  private readonly euler = new Euler();
  private readonly scale = new Vector3(1, 1, 1);
  private static readonly COUNT = 450;

  constructor() {
    this.mesh = new InstancedMesh(
      new PlaneGeometry(0.09, 0.05),
      new MeshBasicMaterial({ side: DoubleSide }),
      Confetti.COUNT
    );
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    const color = new Color();
    for (let i = 0; i < Confetti.COUNT; i++) {
      color.setHex(CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]);
      this.mesh.setColorAt(i, color);
    }
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  /** Rain confetti around `center` (world space) for ~10 seconds. */
  start(center: Vector3): void {
    this.active = true;
    this.elapsed = 0;
    this.mesh.visible = true;
    this.pieces = [];
    for (let i = 0; i < Confetti.COUNT; i++) {
      this.pieces.push(this.spawnPiece(center, true));
    }
  }

  stop(): void {
    this.active = false;
    this.mesh.visible = false;
  }

  private spawnPiece(center: Vector3, initial: boolean): ConfettiPiece {
    return {
      position: new Vector3(
        center.x + (Math.random() - 0.5) * 7,
        center.y + 2.5 + Math.random() * (initial ? 5 : 1.5),
        center.z + (Math.random() - 0.5) * 7
      ),
      velocity: new Vector3(
        (Math.random() - 0.5) * 1.5,
        -1.2 - Math.random() * 1.8,
        (Math.random() - 0.5) * 1.5
      ),
      rotation: new Vector3(
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2
      ),
      spin: new Vector3(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8
      ),
      wobble: Math.random() * Math.PI * 2,
      wobbleSpeed: 2 + Math.random() * 4
    };
  }

  update(dt: number, center: Vector3): void {
    if (!this.active) return;
    this.elapsed += dt;
    const stillRaining = this.elapsed < 10;

    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      p.wobble += p.wobbleSpeed * dt;
      p.position.y += p.velocity.y * dt;
      p.position.x += p.velocity.x * dt + Math.sin(p.wobble) * 0.02;
      p.position.z += p.velocity.z * dt + Math.cos(p.wobble) * 0.02;
      p.rotation.x += p.spin.x * dt;
      p.rotation.y += p.spin.y * dt;
      p.rotation.z += p.spin.z * dt;

      if (p.position.y < center.y - 1.6) {
        if (stillRaining) {
          this.pieces[i] = this.spawnPiece(center, false);
        } else {
          p.position.y = -9999; // parked far away until stop()
          p.velocity.y = 0;
        }
      }

      this.euler.set(p.rotation.x, p.rotation.y, p.rotation.z);
      this.quaternion.setFromEuler(this.euler);
      this.matrix.compose(p.position, this.quaternion, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;

    if (!stillRaining && this.elapsed > 16) {
      this.stop();
    }
  }
}
