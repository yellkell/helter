import {
  BufferGeometry,
  Color,
  createSystem,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  OctahedronGeometry,
  Quaternion,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3
} from '@iwsdk/core';

import { LANE_X } from '../constants.js';
import { LIGHT_GLSL, makeGlow, makeTextTexture } from '../env/fx.js';
import { HelterPath, helterPath } from '../ride/path.js';
import { audio } from '../audio.js';
import { game, on } from '../state.js';
import { EnvironmentSystem } from './environment.js';
import { type Gate, SlideSystem } from './slide.js';

/** Coins run in strings this far apart along the slide. */
const COIN_STEP = 2.2;
/** Chest height above the bed — where you'd sweep an arm through them. */
const COIN_HEIGHT = 1.35;
/** How far across a lane you can be and still take the coin. */
const CATCH_WIDTH = 0.4;
/** A gate this close to a coin's position blocks that lane for coins. */
const GATE_CLEARANCE = 3.2;
const GEM_VALUE = 5;
const MAX_COINS = 480;
const MAX_GEMS = 12;
const COIN_RADIUS = 0.27;
/** Only pickups within this many metres of the rig spin and bob. */
const NEAR = 80;

interface Pickup {
  s: number;
  lane: number;
  /** World position of the pickup's centre. */
  position: Vector3;
  yaw: number;
  phase: number;
  gem: boolean;
  taken: boolean;
  /** Instance slot in its mesh. */
  index: number;
  /** Was animated last frame — so it gets one final static write on leaving the window. */
  near: boolean;
}

interface Pop {
  sprite: Sprite;
  life: number;
}

/** A taken coin on its way up to the counter. */
interface Flyer {
  mesh: Mesh;
  from: Vector3;
  t: number;
  active: boolean;
}

interface Spark {
  sprite: Sprite;
  velocity: Vector3;
  life: number;
}

interface Label {
  sprite: Sprite;
  life: number;
}

const FLY_TIME = 0.5;
const SPARK_LIFE = 0.5;
const LABEL_LIFE = 0.75;
/** Where a taken coin's celebration starts, in the rig's own frame: just
 * ahead of the eyes, so it's seen at 16 m/s instead of left behind. */
const FX_ORIGIN = new Vector3(0, 1.3, -2.4);

/**
 * Subway Surfers on a slide: strings of spinning coins laid through the
 * gaps between gates, some hopping lanes mid-string so you have to lean
 * for them, and a gem worth five per tier tucked in a side lane. You take
 * a coin by being in its lane when you pass it — the same lean that dodges
 * the boards is the input that earns the points.
 */
export class CoinSystem extends createSystem({}) {
  private coins!: InstancedMesh;
  private gems!: InstancedMesh;
  private uTime = { value: 0 };
  private pickups: Pickup[] = [];
  private pops: Pop[] = [];
  private flyers: Flyer[] = [];
  private gemFlyers: Flyer[] = [];
  private sparks: Spark[] = [];
  private labels: Label[] = [];
  private labelMaterials!: { coin: SpriteMaterial; gem: SpriteMaterial };
  private flyTarget = new Vector3();
  private scratch = new Vector3();
  private streak = 0;
  private streakTimer = 0;
  private sample = HelterPath.makeSample();
  private matrix = new Matrix4();
  private quat = new Quaternion();
  private scale = new Vector3();
  private headWorld = new Vector3();
  private yAxis = new Vector3(0, 1, 0);

  init(): void {
    // One bevelled disc per coin, stood on edge with its face toward the
    // rider: the raised rim and the bevels are real geometry so the coin
    // keeps a crisp shape from every angle, in a few hundred triangles.
    const coinGeo = makeCoinGeometry(COIN_RADIUS, 24);
    const coinMaterial = createPickupMaterial(this.uTime, {
      gem: false,
      face: 0xffd23f,
      edge: 0xf5a623,
      dark: 0xd4790f,
      radius: COIN_RADIUS
    });
    const gemGeo = new OctahedronGeometry(0.26);
    gemGeo.scale(0.8, 1.25, 0.8);
    const gemMaterial = createPickupMaterial(this.uTime, {
      gem: true,
      face: 0xa6ffe4,
      edge: 0x22c49a,
      dark: 0x0f8f6a,
      radius: 0.3
    });
    this.coins = new InstancedMesh(coinGeo, coinMaterial, MAX_COINS);
    this.gems = new InstancedMesh(gemGeo, gemMaterial, MAX_GEMS);
    for (const mesh of [this.coins, this.gems]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.scene.add(mesh);
    }

    // Everything that happens when you take a coin rides with the rig, so
    // it plays out in front of your eyes rather than behind you.
    for (let i = 0; i < 10; i++) {
      const mesh = new Mesh(coinGeo, coinMaterial);
      mesh.visible = false;
      this.player.add(mesh);
      this.flyers.push({ mesh, from: new Vector3(), t: 0, active: false });
    }
    for (let i = 0; i < 3; i++) {
      const mesh = new Mesh(gemGeo, gemMaterial);
      mesh.visible = false;
      this.player.add(mesh);
      this.gemFlyers.push({ mesh, from: new Vector3(), t: 0, active: false });
    }

    // Sparkles that burst out of a pickup.
    for (let i = 0; i < 36; i++) {
      const sprite = makeGlow(0xfff3b8, 0.22, 0);
      sprite.visible = false;
      this.player.add(sprite);
      this.sparks.push({ sprite, velocity: new Vector3(), life: 0 });
    }

    // Floating "+1" / "+5" labels.
    const labelMat = (text: string, color: string): SpriteMaterial =>
      new SpriteMaterial({
        map: makeTextTexture(text, { color, width: 256, height: 128 }),
        transparent: true,
        depthWrite: false
      });
    this.labelMaterials = { coin: labelMat('+1', '#ffd54a'), gem: labelMat('+5', '#8ff0d2') };
    for (let i = 0; i < 6; i++) {
      const sprite = new Sprite(this.labelMaterials.coin.clone());
      sprite.scale.set(0.7, 0.35, 1);
      sprite.visible = false;
      this.player.add(sprite);
      this.labels.push({ sprite, life: 0 });
    }

    // A small pool of glow bursts for the pickup pop.
    for (let i = 0; i < 8; i++) {
      const sprite = makeGlow(0xfff0a8, 1, 0);
      sprite.visible = false;
      this.player.add(sprite);
      this.pops.push({ sprite, life: 0 });
    }

    on('game-reset', () => this.clear());
    on('game-over', () => {
      this.streak = 0;
    });
  }

  private clear(): void {
    this.pickups = [];
    this.coins.count = 0;
    this.gems.count = 0;
    this.streak = 0;
    for (const f of this.flyers) {
      f.active = false;
      f.mesh.visible = false;
    }
    for (const f of this.gemFlyers) {
      f.active = false;
      f.mesh.visible = false;
    }
    for (const s of this.sparks) {
      s.life = 0;
      s.sprite.visible = false;
    }
    for (const l of this.labels) {
      l.life = 0;
      l.sprite.visible = false;
    }
    for (const p of this.pops) {
      p.life = 0;
      p.sprite.visible = false;
    }
  }

  /**
   * Lay the coins for the whole ride, avoiding every gate. Called after the
   * gates are stood up, so a coin never sits inside a board.
   */
  build(gates: Gate[]): void {
    this.clear();
    const laneFree = (s0: number, s1: number, lane: number): boolean =>
      !gates.some(
        (g) => g.lane === lane && g.s > s0 - GATE_CLEARANCE && g.s < s1 + GATE_CLEARANCE
      );
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

    helterPath.tiers.forEach((tier, tierIndex) => {
      let s = tier.helixS0 + 9;
      let gemPlaced = false;
      const end = tier.helixS1 - 14;
      while (s < end) {
        const run = 6 + Math.floor(Math.random() * 6);
        const length = (run - 1) * COIN_STEP;
        if (s + length > end) break;

        // Prefer a lane that's clear for the whole string; fall back to a
        // string that hops lanes halfway when nothing is clear end to end.
        const lanes = [0, 1, 2].sort(() => Math.random() - 0.5);
        let laneA = lanes.find((l) => laneFree(s, s + length, l));
        let laneB = laneA;
        if (laneA === undefined) {
          const half = s + length / 2;
          laneA = lanes.find((l) => laneFree(s, half, l));
          laneB = lanes.find((l) => laneFree(half, s + length, l));
        } else if (run >= 9 && Math.random() < 0.55) {
          // A deliberate hop: reward the lean even when one lane would do.
          const half = s + length / 2;
          const other = lanes.find((l) => l !== laneA && laneFree(half, s + length, l));
          if (other !== undefined) laneB = other;
        }
        if (laneA === undefined || laneB === undefined) {
          s += 4;
          continue;
        }

        // The gem: once per tier, at the head of a side-lane string, so it
        // costs a lean and a bit of nerve around the gates.
        if (!gemPlaced && tierIndex <= 2 && laneA !== 1 && Math.random() < 0.5) {
          this.place(s - COIN_STEP, laneA, true);
          gemPlaced = true;
        }

        for (let i = 0; i < run; i++) {
          const lane = i < run / 2 ? laneA : laneB;
          if (this.coins.count >= MAX_COINS) break;
          this.place(s + i * COIN_STEP, lane, false);
        }
        s += length + 5 + Math.random() * 9;
      }
      if (!gemPlaced) {
        // Guarantee one gem per tier: drop it into any clear side lane.
        for (let tries = 0; tries < 20 && !gemPlaced; tries++) {
          const gs = tier.helixS0 + 12 + Math.random() * (end - tier.helixS0 - 24);
          const lane = pick([0, 2]);
          if (laneFree(gs, gs, lane)) {
            this.place(gs, lane, true);
            gemPlaced = true;
          }
        }
      }
    });

    game.coinsTotal = this.pickups.reduce((n, p) => n + (p.gem ? GEM_VALUE : 1), 0);
    game.coins = 0;
    // Every pickup gets its resting pose once; after that only the ones
    // near the rider are touched each frame.
    for (const p of this.pickups) this.writePickup(p, 0, false);
    this.coins.instanceMatrix.needsUpdate = true;
    this.gems.instanceMatrix.needsUpdate = true;
  }

  private place(s: number, lane: number, gem: boolean): void {
    const mesh = gem ? this.gems : this.coins;
    if (mesh.count >= (gem ? MAX_GEMS : MAX_COINS)) return;
    helterPath.sample(s, this.sample);
    const position = this.sample.position
      .clone()
      .addScaledVector(this.sample.right, LANE_X[lane]);
    position.y += COIN_HEIGHT;
    this.pickups.push({
      s,
      lane,
      position,
      yaw: this.sample.yaw,
      phase: Math.random() * Math.PI * 2,
      gem,
      taken: false,
      index: mesh.count,
      near: false
    });
    mesh.count += 1;
  }

  /** Write one pickup's instance matrix: spinning and bobbing if `animate`. */
  private writePickup(p: Pickup, t: number, animate: boolean): void {
    const mesh = p.gem ? this.gems : this.coins;
    if (p.taken) {
      this.scale.setScalar(0);
      this.matrix.compose(p.position, this.quat.identity(), this.scale);
      mesh.setMatrixAt(p.index, this.matrix);
      return;
    }
    const spin = animate ? t * (p.gem ? 3.0 : 7.0) + p.phase : p.phase;
    this.quat.setFromAxisAngle(this.yAxis, p.yaw + spin);
    this.scale.setScalar(1);
    this.matrix.compose(p.position, this.quat, this.scale);
    // A wave runs down each string; gems bob a little more.
    if (animate) this.matrix.elements[13] += Math.sin(t * 3.2 - p.s * 0.9) * (p.gem ? 0.1 : 0.06);
    mesh.setMatrixAt(p.index, this.matrix);
  }

  /** Animate the pickups around the rider; the rest stay as they were. */
  private updatePickups(t: number): void {
    const here = game.distance;
    let coinsDirty = false;
    let gemsDirty = false;
    for (const p of this.pickups) {
      if (p.taken) continue;
      const near = Math.abs(p.s - here) < NEAR;
      if (!near && !p.near) continue;
      p.near = near;
      this.writePickup(p, t, near);
      if (p.gem) gemsDirty = true;
      else coinsDirty = true;
    }
    if (coinsDirty) this.coins.instanceMatrix.needsUpdate = true;
    if (gemsDirty) this.gems.instanceMatrix.needsUpdate = true;
  }

  private collect(p: Pickup): void {
    p.taken = true;
    this.writePickup(p, 0, false);
    (p.gem ? this.gems : this.coins).instanceMatrix.needsUpdate = true;
    this.streak += 1;
    this.streakTimer = 1.4;
    game.coins += p.gem ? GEM_VALUE : 1;
    audio.coin(this.streak, p.gem);

    // The celebration starts just ahead of the eyes, on the coin's side.
    const origin = this.scratch.copy(FX_ORIGIN);
    origin.x += LANE_X[p.lane] * 1.3;

    // Flash at the pickup point.
    const pop = this.pops.find((q) => q.life <= 0) ?? this.pops[0];
    pop.life = 0.35;
    pop.sprite.position.copy(origin);
    pop.sprite.visible = true;
    (pop.sprite.material as { color: Color }).color.setHex(p.gem ? 0xbfffe9 : 0xfff0a8);

    // The coin itself lifts off toward the counter.
    const pool = p.gem ? this.gemFlyers : this.flyers;
    const flyer = pool.find((f) => !f.active) ?? pool[0];
    flyer.active = true;
    flyer.t = 0;
    flyer.from.copy(origin);
    flyer.mesh.position.copy(origin);
    flyer.mesh.scale.setScalar(1);
    flyer.mesh.visible = true;

    // Sparkles burst outward and fall.
    let spawned = 0;
    for (const s of this.sparks) {
      if (s.life > 0) continue;
      s.life = SPARK_LIFE;
      s.sprite.position.copy(origin);
      s.velocity
        .set(Math.random() - 0.5, Math.random() * 0.6 + 0.2, Math.random() - 0.5)
        .normalize()
        .multiplyScalar(1.6 + Math.random() * 1.8);
      s.sprite.visible = true;
      (s.sprite.material as { color: Color }).color.setHex(p.gem ? 0xa8ffe4 : 0xfff1a0);
      if (++spawned >= (p.gem ? 10 : 6)) break;
    }

    // "+1" / "+5" floats up and fades.
    const label = this.labels.find((l) => l.life <= 0) ?? this.labels[0];
    label.life = LABEL_LIFE;
    label.sprite.material = p.gem ? this.labelMaterials.gem : this.labelMaterials.coin;
    label.sprite.scale.set(p.gem ? 0.9 : 0.7, p.gem ? 0.45 : 0.35, 1);
    label.sprite.position.copy(origin);
    label.sprite.position.y += 0.35;
    label.sprite.visible = true;
  }

  /**
   * Where taken coins fly to, in the rig's frame: into the HUD counter
   * itself, so they land in the number rather than hanging in front of
   * it. Falls back to a point ahead of the eyes if the panel is parked.
   */
  private updateFlyTarget(): void {
    const hud = (this.globals.panels as { hud?: { object3D?: Object3D } } | undefined)?.hud
      ?.object3D;
    if (hud && hud.position.y > -100) {
      this.flyTarget.copy(hud.position);
      this.flyTarget.y -= 0.1;
      return;
    }
    this.flyTarget.set(0, 1.9, -2.4);
  }

  private updateFlyer(f: Flyer, delta: number): void {
    if (!f.active) return;
    f.t += delta;
    const k = Math.min(1, f.t / FLY_TIME);
    const ease = 1 - (1 - k) * (1 - k);
    f.mesh.position.lerpVectors(f.from, this.flyTarget, ease);
    f.mesh.position.y += Math.sin(k * Math.PI) * 0.35; // a little arc
    f.mesh.scale.setScalar(Math.max(0.001, 1 - k * 0.85));
    f.mesh.rotation.y += delta * 16;
    if (k >= 1) {
      f.active = false;
      f.mesh.visible = false;
    }
  }

  private updateEffects(delta: number): void {
    this.updateFlyTarget();
    for (const f of this.flyers) this.updateFlyer(f, delta);
    for (const f of this.gemFlyers) this.updateFlyer(f, delta);
    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= delta;
      s.velocity.y -= 7 * delta;
      s.sprite.position.addScaledVector(s.velocity, delta);
      const k = Math.max(0, s.life / SPARK_LIFE);
      s.sprite.scale.setScalar(0.1 + 0.2 * k);
      (s.sprite.material as { opacity: number }).opacity = k;
      if (s.life <= 0) s.sprite.visible = false;
    }
    for (const l of this.labels) {
      if (l.life <= 0) continue;
      l.life -= delta;
      l.sprite.position.y += delta * 1.1;
      const k = Math.max(0, l.life / LABEL_LIFE);
      (l.sprite.material as { opacity: number }).opacity = Math.min(1, k * 1.6);
      if (l.life <= 0) l.sprite.visible = false;
    }
    for (const pop of this.pops) {
      if (pop.life <= 0) continue;
      pop.life -= delta;
      const k = 1 - Math.max(0, pop.life) / 0.35;
      pop.sprite.scale.setScalar(0.5 + k * 2.0);
      (pop.sprite.material as { opacity: number }).opacity = (1 - k) * 0.8;
      if (pop.life <= 0) pop.sprite.visible = false;
    }
  }

  update(delta: number, time: number): void {
    const t = time / 1000;
    this.uTime.value = t;

    if (this.streakTimer > 0) {
      this.streakTimer -= delta;
      if (this.streakTimer <= 0) this.streak = 0;
    }

    this.updateEffects(delta);

    if (this.pickups.length === 0) return;

    // Sweep: anything whose arc-length we crossed this frame, in our lane.
    if (game.phase === 'SLIDE') {
      const slide = this.world.getSystem(SlideSystem);
      const env = this.world.getSystem(EnvironmentSystem);
      if (slide && env) {
        env.getHeadWorld(this.headWorld);
        const lateral = slide.lateralOf(this.headWorld);
        const from = slide.previousDistance - 0.3;
        const to = slide.distance + 0.3;
        for (const p of this.pickups) {
          if (p.taken || p.s < from || p.s > to) continue;
          if (Math.abs(lateral - LANE_X[p.lane]) < CATCH_WIDTH) this.collect(p);
        }
      }
    }

    this.updatePickups(t);
  }
}

// ---------------------------------------------------------------------------
// Coin geometry — a bevelled disc, axis along +Z (face toward the rider).
// ---------------------------------------------------------------------------

/**
 * Lathe a coin profile around Z with a hard crease between every profile
 * segment and smooth shading around the rim, so the flat face reads flat,
 * the bevels catch the light as rings, and the edge stays round. Front
 * face at +Z. About 400 triangles at 24 sides.
 */
function makeCoinGeometry(radius: number, sides: number): BufferGeometry {
  const h = 0.032; // half thickness of the face
  const lip = 0.014; // how far the rim stands proud of the face
  // Profile as (r, z) from the front centre round to the back centre.
  const front: Array<[number, number]> = [
    [0, h],
    [radius * 0.72, h],
    [radius * 0.82, h + lip],
    [radius * 0.94, h + lip],
    [radius, h - 0.004]
  ];
  const back = front.map(([r, z]): [number, number] => [r, -z]).reverse();
  const profile = [...front, ...back];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const n = new Vector3();

  for (let k = 0; k < profile.length - 1; k++) {
    const [r0, z0] = profile[k];
    const [r1, z1] = profile[k + 1];
    const dr = r1 - r0;
    const dz = z1 - z0;
    // Outward normal of this profile segment in the (r, z) plane.
    let nr = -dz;
    let nz = dr;
    const len = Math.hypot(nr, nz) || 1;
    nr /= len;
    nz /= len;
    const base = positions.length / 3;
    for (let i = 0; i <= sides; i++) {
      const angle = (i / sides) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      positions.push(r0 * cos, r0 * sin, z0, r1 * cos, r1 * sin, z1);
      normals.push(nr * cos, nr * sin, nz, nr * cos, nr * sin, nz);
    }
    // Wind each quad so it faces its normal (the profile changes direction
    // on the back half, so check rather than assume).
    const i0 = base;
    const i1 = base + 1;
    const i2 = base + 2;
    const i3 = base + 3;
    a.fromArray(positions, i0 * 3);
    b.fromArray(positions, i1 * 3);
    c.fromArray(positions, i2 * 3);
    n.subVectors(b, a).cross(c.sub(a));
    if (n.lengthSq() < 1e-12) {
      // Degenerate at a centre point — test the other triangle.
      a.fromArray(positions, i1 * 3);
      b.fromArray(positions, i3 * 3);
      c.fromArray(positions, i2 * 3);
      n.subVectors(b, a).cross(c.sub(a));
    }
    const flip = n.x * nr + n.z * nz < 0; // the first quad sits at angle 0
    for (let i = 0; i < sides; i++) {
      const p0 = base + i * 2;
      const p1 = p0 + 1;
      const p2 = p0 + 2;
      const p3 = p0 + 3;
      if (flip) indices.push(p0, p2, p1, p1, p2, p3);
      else indices.push(p0, p1, p2, p1, p3, p2);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

// ---------------------------------------------------------------------------
// Pickup material — Mario gold: flat cel steps, a hard gloss flash as the
// face swings through the light, a bright bevel ring, and an ink silhouette.
// ---------------------------------------------------------------------------

function createPickupMaterial(
  uTime: { value: number },
  opts: { gem: boolean; face: number; edge: number; dark: number; radius: number }
): ShaderMaterial {
  return new ShaderMaterial({
    fog: true,
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime,
        uFace: { value: new Color(opts.face) },
        uEdge: { value: new Color(opts.edge) },
        uDark: { value: new Color(opts.dark) },
        uGem: { value: opts.gem ? 1 : 0 },
        uRadius: { value: opts.radius }
      }
    ]),
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vLocalN;
      varying vec3 vWorldN;
      varying vec3 vWorldPos;
      #include <fog_pars_vertex>
      void main() {
        vLocal = position;
        vLocalN = normal;
        #ifdef USE_INSTANCING
          mat4 mm = modelMatrix * instanceMatrix;
        #else
          mat4 mm = modelMatrix;
        #endif
        vec4 wp = mm * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldN = normalize(mat3(mm) * normal);
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vLocalN;
      varying vec3 vWorldN;
      varying vec3 vWorldPos;
      uniform float uTime;
      uniform vec3 uFace;
      uniform vec3 uEdge;
      uniform vec3 uDark;
      uniform float uGem;
      uniform float uRadius;
      #include <fog_pars_fragment>
      ${LIGHT_GLSL}
      void main() {
        vec3 n = normalize(vWorldN);
        vec3 v = normalize(cameraPosition - vWorldPos);
        vec3 ln = normalize(vLocalN);

        vec3 col;
        float faceness;
        if (uGem < 0.5) {
          // Flat faces are bright gold, bevels and edge a deeper orange-gold.
          faceness = smoothstep(0.8, 0.95, abs(ln.z));
          col = mix(uEdge, uFace, faceness);
          // A darker embossed ring inside the rim, like a struck coin.
          float r = length(vLocal.xy) / uRadius;
          float ring = smoothstep(0.60, 0.64, r) * (1.0 - smoothstep(0.68, 0.72, r));
          col = mix(col, uDark, ring * faceness * 0.6);
        } else {
          faceness = 0.0;
          col = mix(uEdge, uFace, smoothstep(-0.3, 0.8, ln.y));
        }

        // Three flat sun steps; the pickups stay bright even in shade.
        float lit = celBands(dot(n, SUN_DIR));
        col *= 0.72 + 0.34 * lit;
        // Metal reflects its surroundings: sky above brightens, ground below darkens.
        vec3 refl = reflect(-v, n);
        col *= mix(0.80, 1.14, smoothstep(-0.3, 0.6, refl.y));

        // Gloss. The flat face flashes near-white as it swings through the
        // light (the horizontal half-vector, so a spinning coin actually
        // hits it); the bevels and edge carry a tight highlight ring.
        vec3 h = normalize(SUN_DIR + v);
        vec3 hh = normalize(vec3(h.x, 0.0, h.z));
        float swing = max(dot(n, hh), 0.0);
        float flash = smoothstep(0.92, 0.99, swing) * faceness;
        float gloss = pow(swing, 5.0) * 0.16 * faceness;
        float spec = pow(max(dot(n, h), 0.0), 36.0);
        float glint = smoothstep(0.25, 0.5, spec) * (1.0 - faceness);
        col += vec3(1.0, 0.97, 0.85) * (flash * 0.7 + gloss + glint * 0.7);

        // Ink silhouette from the view angle, matching the outlined world.
        float facing = abs(dot(n, v));
        col = mix(vec3(0.16, 0.10, 0.04), col, smoothstep(0.10, 0.26, facing));

        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `
  });
}
