import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  TubeGeometry,
  UniformsLib,
  UniformsUtils,
  Vector3
} from '@iwsdk/core';

import {
  BARRIER_SIZE,
  INNER_LIP,
  OUTER_LIP,
  PAINT,
  SLIDE_PITCH,
  TRACK_WIDTH
} from '../constants.js';
import { HelterPath, type PathSample } from '../ride/path.js';
import { LIGHT_GLSL, makeStripeTexture, makeTextTexture, NOISE_GLSL } from './fx.js';

export interface TrackHandles {
  group: Group;
  uniforms: { uTime: { value: number } };
  /** Expanding ring shown on the bay when a tier lands (DOWN's shockwave). */
  arrivalRing: Mesh;
}

const SAMPLE_STEP = 0.6;

type Offset = (s: PathSample, out: Vector3) => Vector3;

/**
 * Builds a two-edged strip of quads along the path: edge A and edge B are
 * given as offsets from each sample. UV.x runs 0..1 from A to B, UV.y is
 * the distance along the slide in metres.
 */
function buildStrip(
  samples: PathSample[],
  distances: number[],
  edgeA: Offset,
  edgeB: Offset,
  normalOf: (s: PathSample, out: Vector3) => Vector3
): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const n = new Vector3();
  samples.forEach((s, i) => {
    edgeA(s, a);
    edgeB(s, b);
    normalOf(s, n);
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    normals.push(n.x, n.y, n.z, n.x, n.y, n.z);
    uvs.push(0, distances[i], 1, distances[i]);
    if (i < samples.length - 1) {
      const k = i * 2;
      indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/** Painted slide bed: cream boards, red lane lines, gold arrows flowing downhill. */
function createBedMaterial(uTime: { value: number }): ShaderMaterial {
  return new ShaderMaterial({
    fog: true,
    side: DoubleSide,
    uniforms: UniformsUtils.merge([UniformsLib.fog, { uTime, uWidth: { value: TRACK_WIDTH } }]),
    vertexShader: /* glsl */ `
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
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec2 vUv;
      uniform float uTime;
      uniform float uWidth;
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      ${LIGHT_GLSL}

      float lineAt(float x, float target, float width) {
        float d = abs(x - target);
        float w = fwidth(d) * 1.5;
        return 1.0 - smoothstep(width, width + w, d);
      }

      void main() {
        float x = (vUv.x - 0.5) * uWidth; // metres across, - outer .. + tower
        float s = vUv.y;                  // metres along

        vec3 cream = vec3(0.93, 0.85, 0.68);
        vec3 red = vec3(0.78, 0.09, 0.07);
        vec3 gold = vec3(0.92, 0.70, 0.18);

        // Painted boards: faint plank seams every 0.4m along, wood grain.
        vec3 albedo = cream;
        float grain = fbm(vec3(x * 9.0, s * 0.9, 1.0)) - 0.5;
        albedo *= 1.0 + grain * 0.10;
        float seam = 1.0 - lineAt(fract(s / 0.4) * 0.4, 0.2, 0.006) * 0.35;
        albedo *= seam;
        // Varnish darkens a touch toward the edges where feet don't polish it.
        albedo *= 1.0 - smoothstep(0.6, 1.2, abs(x)) * 0.12;

        // Lane lines framing the three lanes (centres at -0.5, 0, 0.5).
        float lanes = lineAt(x, -0.75, 0.02) + lineAt(x, -0.25, 0.02)
                    + lineAt(x, 0.25, 0.02) + lineAt(x, 0.75, 0.02);
        albedo = mix(albedo, red, clamp(lanes, 0.0, 1.0) * 0.9);

        // Gold chevrons flowing downhill — DOWN's motion cue, in paint.
        float chev = fract((s + abs(x) * 1.6) * 0.14 - uTime * 1.4);
        float arrow = smoothstep(0.0, 0.05, chev) * smoothstep(0.16, 0.11, chev);
        albedo = mix(albedo, gold, arrow * 0.55);

        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 col = shade(albedo, n);
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `
  });
}

/**
 * The slide, built once around the tower: a painted bed with lane lines,
 * a tall outer lip and a low inner one, gold rails along both, a dark
 * underside, and iron brackets tying it back to the tower.
 */
export function createSlideTrack(path: HelterPath): TrackHandles {
  const group = new Group();
  const uTime = { value: 0 };

  // Sample the whole path once.
  const samples: PathSample[] = [];
  const distances: number[] = [];
  const count = Math.ceil(path.totalLength / SAMPLE_STEP);
  for (let i = 0; i <= count; i++) {
    const s = Math.min(path.totalLength, i * SAMPLE_STEP);
    samples.push(path.sample(s, HelterPath.makeSample()));
    distances.push(s);
  }

  const half = TRACK_WIDTH / 2;
  const up = new Vector3(0, 1, 0);
  const at = (dx: number, dy: number): Offset => (s, out) =>
    out.copy(s.position).addScaledVector(s.right, dx).addScaledVector(up, dy);
  const upNormal = (_s: PathSample, out: Vector3): Vector3 => out.set(0, 1, 0);
  const downNormal = (_s: PathSample, out: Vector3): Vector3 => out.set(0, -1, 0);
  const inwardNormal = (s: PathSample, out: Vector3): Vector3 => out.copy(s.right); // faces the bed from the outer lip
  const outwardNormal = (s: PathSample, out: Vector3): Vector3 => out.copy(s.right).negate();

  // Bed (the rig's floor is exactly this surface).
  const bed = new Mesh(
    buildStrip(samples, distances, at(-half, 0.0), at(half, 0.0), upNormal),
    createBedMaterial(uTime)
  );
  group.add(bed);

  // Lips: tall on the outside (that's where you'd fly off), low by the tower.
  const lipMaterial = new MeshLambertMaterial({ color: PAINT.red, side: DoubleSide });
  const outerLip = new Mesh(
    buildStrip(samples, distances, at(-half, 0.0), at(-half, OUTER_LIP), inwardNormal),
    lipMaterial
  );
  const innerLip = new Mesh(
    buildStrip(samples, distances, at(half, 0.0), at(half, INNER_LIP), outwardNormal),
    lipMaterial
  );
  group.add(outerLip, innerLip);

  // Cream cap boards along the lip tops.
  const capMaterial = new MeshLambertMaterial({ color: 0xf3e8d2, side: DoubleSide });
  group.add(
    new Mesh(
      buildStrip(samples, distances, at(-half - 0.12, OUTER_LIP), at(-half + 0.12, OUTER_LIP), upNormal),
      capMaterial
    ),
    new Mesh(
      buildStrip(samples, distances, at(half - 0.1, INNER_LIP), at(half + 0.1, INNER_LIP), upNormal),
      capMaterial
    )
  );

  // Underside + outer skirt so the slide has thickness from below.
  const underMaterial = new MeshLambertMaterial({ color: 0x6b2a22, side: DoubleSide });
  group.add(
    new Mesh(buildStrip(samples, distances, at(-half, -0.16), at(half, -0.16), downNormal), underMaterial),
    new Mesh(buildStrip(samples, distances, at(-half, -0.16), at(-half, 0.0), outwardNormal), underMaterial)
  );

  // Gold handrails riding the lip tops.
  const railMaterial = new MeshLambertMaterial({ color: PAINT.gold });
  const railPoints = (dx: number, dy: number): Vector3[] =>
    samples.filter((_, i) => i % 2 === 0).map((s) => at(dx, dy)(s, new Vector3()));
  const makeRail = (dx: number, dy: number, radius: number): Mesh => {
    const curve = new CatmullRomCurve3(railPoints(dx, dy), false, 'catmullrom', 0.0);
    const geometry = new TubeGeometry(curve, Math.ceil(samples.length / 2), radius, 6, false);
    return new Mesh(geometry, railMaterial);
  };
  group.add(makeRail(-half, OUTER_LIP + 0.06, 0.055), makeRail(half, INNER_LIP + 0.05, 0.045));

  // Iron brackets back to the tower wall — every few metres of the spiral.
  const ironMaterial = new MeshLambertMaterial({ color: 0x2a2624 });
  const helixSamples = samples.filter((s, i) => !s.flat && i % 10 === 0);
  const brackets = new InstancedMesh(new BoxGeometry(1, 1, 1), ironMaterial, helixSamples.length * 2);
  const m = new Matrix4();
  const q = new Quaternion();
  const qRoll = new Quaternion();
  const pos = new Vector3();
  const scale = new Vector3();
  const zAxis = new Vector3(0, 0, 1);
  const yAxis = new Vector3(0, 1, 0);
  const wallX = half + 0.4; // the tower wall in rig-space x
  helixSamples.forEach((s, i) => {
    q.setFromAxisAngle(yAxis, s.yaw);
    // Horizontal beam under the bed, outer edge to the wall.
    at((-half - 0.25 + wallX) / 2, -0.3)(s, pos);
    scale.set(TRACK_WIDTH + 0.65, 0.16, 0.16);
    m.compose(pos, q, scale);
    brackets.setMatrixAt(i * 2, m);
    // Diagonal brace from the outer edge down to the wall.
    const run = wallX + half;
    const drop = 2.4;
    at(0.2, -0.3 - drop / 2)(s, pos);
    qRoll.setFromAxisAngle(zAxis, Math.atan2(drop, run));
    scale.set(Math.hypot(run, drop), 0.12, 0.12);
    m.compose(pos, q.clone().multiply(qRoll), scale);
    brackets.setMatrixAt(i * 2 + 1, m);
  });
  group.add(brackets);

  // Landing shockwave ring: parked until a tier lands.
  const arrivalRing = new Mesh(
    new RingGeometry(0.8, 1.0, 48),
    new MeshBasicMaterial({
      color: 0xfff1c0,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide
    })
  );
  arrivalRing.rotation.x = -Math.PI / 2;
  arrivalRing.visible = false;
  group.add(arrivalRing);

  // Finish: a painted arch just past the exit strip.
  const end = path.sample(path.totalLength, HelterPath.makeSample());
  group.add(createFinishArch(end));

  return { group, uniforms: { uTime }, arrivalRing };
}

function createFinishArch(end: PathSample): Group {
  const arch = new Group();
  const ahead = end.position.clone().addScaledVector(end.forward, 5.2);
  ahead.y = end.position.y;
  arch.position.copy(ahead);
  arch.rotation.y = end.yaw;

  const postMat = new MeshLambertMaterial({ color: PAINT.red });
  const postGeo = new CylinderGeometry(0.16, 0.16, 3.6, 10);
  [-2.2, 2.2].forEach((x) => {
    const post = new Mesh(postGeo, postMat);
    post.position.set(x, 1.8, 0);
    arch.add(post);
  });
  const sign = new Mesh(
    new PlaneGeometry(5.2, 1.3),
    new MeshLambertMaterial({
      map: makeTextTexture('WELL DONE  -  MIND THE STEP', {
        color: '#e8322e',
        background: '#fff4e0',
        border: '#e8322e'
      }),
      side: DoubleSide
    })
  );
  sign.position.set(0, 3.3, 0);
  arch.add(sign);
  return arch;
}

// ---------------------------------------------------------------------------
// Gates — DOWN's slide barriers, dressed as fairground boards.
// ---------------------------------------------------------------------------

let gateGeometry: BoxGeometry | null = null;
const gateMaterials = new Map<number, MeshLambertMaterial>();
let pennantGeometry: ConeGeometry | null = null;

function toHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * A candy-striped board with a pennant on top, exactly the size DOWN's
 * collision test expects. Lean past it or you're off the ride.
 */
export function createGate(color: number): Group {
  gateGeometry ??= new BoxGeometry(BARRIER_SIZE.w, BARRIER_SIZE.h, BARRIER_SIZE.d);
  pennantGeometry ??= new ConeGeometry(0.16, 0.5, 4);
  let material = gateMaterials.get(color);
  if (!material) {
    material = new MeshLambertMaterial({ map: makeStripeTexture(toHex(color), '#fff4e0', 6) });
    gateMaterials.set(color, material);
  }
  const group = new Group();
  const board = new Mesh(gateGeometry, material);
  group.add(board);
  const pennant = new Mesh(pennantGeometry, new MeshLambertMaterial({ color: PAINT.gold }));
  pennant.position.y = BARRIER_SIZE.h / 2 + 0.25;
  group.add(pennant);
  return group;
}

// ---------------------------------------------------------------------------

export interface StreakHandles {
  object: LineSegments;
  uniforms: {
    uOffset: { value: number };
    uStrength: { value: number };
  };
}

/**
 * Wind streaks that whip past during slides — DOWN's, in daylight colours.
 * One draw call; the whole field scrolls via a wrap-around offset in the
 * vertex shader. Raked down the slope so they run parallel to the descent.
 */
export function createStreaks(): StreakHandles {
  const COUNT = 170;
  const WINDOW = 46;
  const positions: number[] = [];
  const alphas: number[] = [];
  const colors: number[] = [];
  const white = new Color(0xffffff);
  const cream = new Color(0xfff1c8);
  const pale = new Color(0xcfe9ff);

  for (let i = 0; i < COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 2.6 + Math.random() * 5.5;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius * 0.7 + 1.2;
    const z = -Math.random() * WINDOW;
    const len = 1.2 + Math.random() * 2.2;
    positions.push(x, y, z, x, y, z - len);
    const c = Math.random() < 0.5 ? white : Math.random() < 0.5 ? cream : pale;
    colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    alphas.push(0.85, 0.0);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aAlpha', new Float32BufferAttribute(alphas, 1));

  const uniforms = { uOffset: { value: 0 }, uStrength: { value: 0 } };
  const material = new ShaderMaterial({
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    uniforms,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aAlpha;
      uniform float uOffset;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = aColor;
        vAlpha = aAlpha;
        vec3 p = position;
        p.z = mod(p.z + uOffset, 46.0) - 38.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uStrength;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        gl_FragColor = vec4(vColor, vAlpha * uStrength * 0.5);
      }
    `
  });

  const object = new LineSegments(geometry, material);
  object.frustumCulled = false;
  object.visible = false;
  object.rotation.x = -SLIDE_PITCH;
  return { object, uniforms };
}
