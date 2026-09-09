import {
  AdditiveBlending,
  Color,
  createSystem,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
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
  private coinRims!: InstancedMesh;
  private coinHalos!: InstancedMesh;
  private gemHalos!: InstancedMesh;
  private uTime = { value: 0 };
  private pickups: Pickup[] = [];
  private pops: Pop[] = [];
  private flyers: Flyer[] = [];
  private gemFlyers: Flyer[] = [];
  private sparks: Spark[] = [];
  private labels: Label[] = [];
  private labelMaterials!: { coin: SpriteMaterial; gem: SpriteMaterial };
  private flyTarget = new Vector3();
  private rigForward = new Vector3();
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
    // A coin stood on edge, face toward the rider: cylinder axis along Z.
    const coinGeo = new CylinderGeometry(0.27, 0.27, 0.07, 22);
    coinGeo.rotateX(Math.PI / 2);
    // Self-lit, saturated, with a cartoon glint: never mustard in the shade.
    const coinMaterial = createPickupMaterial(this.uTime, {
      mode: 0,
      face: 0xffcf1f,
      edge: 0xf28f14,
      radius: 0.27
    });
    const rimMaterial = createPickupMaterial(this.uTime, {
      mode: 1,
      face: 0xf0861a,
      edge: 0xf0861a,
      radius: 0.27
    });
    const gemMaterial = createPickupMaterial(this.uTime, {
      mode: 2,
      face: 0x8dffd8,
      edge: 0x18b58e,
      radius: 0.3
    });
    const coinHaloMaterial = createHaloMaterial(this.uTime, 0xffc63a, 1.5);
    const gemHaloMaterial = createHaloMaterial(this.uTime, 0x8dffd8, 1.7);
    this.coins = new InstancedMesh(coinGeo, coinMaterial, MAX_COINS);
    // A darker gold rim, real geometry, so the coin keeps its edge from any
    // angle — a pushed-out ink hull only ever showed at the silhouette.
    const rimGeo = new TorusGeometry(0.265, 0.045, 8, 28);
    this.coinRims = new InstancedMesh(rimGeo, rimMaterial, MAX_COINS);
    this.coinRims.instanceMatrix = this.coins.instanceMatrix;
    const gemGeo = new OctahedronGeometry(0.26);
    gemGeo.scale(0.8, 1.25, 0.8);
    this.gems = new InstancedMesh(gemGeo, gemMaterial, MAX_GEMS);
    // Soft glow behind every pickup: camera-facing quads sharing the matrices.
    const haloGeo = new PlaneGeometry(1, 1);
    this.coinHalos = new InstancedMesh(haloGeo, coinHaloMaterial, MAX_COINS);
    this.coinHalos.instanceMatrix = this.coins.instanceMatrix;
    this.gemHalos = new InstancedMesh(haloGeo, gemHaloMaterial, MAX_GEMS);
    this.gemHalos.instanceMatrix = this.gems.instanceMatrix;
    for (const mesh of [this.coins, this.coinRims, this.gems, this.coinHalos, this.gemHalos]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.scene.add(mesh);
    }
    this.coinHalos.renderOrder = 5;
    this.gemHalos.renderOrder = 5;

    // Flyers: the coin you just took, spinning up toward the counter.
    for (let i = 0; i < 10; i++) {
      const mesh = new Mesh(coinGeo, coinMaterial);
      mesh.add(new Mesh(rimGeo, rimMaterial));
      const halo = new Mesh(haloGeo, coinHaloMaterial);
      halo.renderOrder = 5;
      mesh.add(halo);
      mesh.visible = false;
      this.scene.add(mesh);
      this.flyers.push({ mesh, from: new Vector3(), t: 0, active: false });
    }
    for (let i = 0; i < 3; i++) {
      const mesh = new Mesh(gemGeo, gemMaterial);
      const halo = new Mesh(haloGeo, gemHaloMaterial);
      halo.renderOrder = 5;
      mesh.add(halo);
      mesh.visible = false;
      this.scene.add(mesh);
      this.gemFlyers.push({ mesh, from: new Vector3(), t: 0, active: false });
    }

    // Sparkles that burst out of a pickup.
    for (let i = 0; i < 42; i++) {
      const sprite = makeGlow(0xfff3b8, 0.22, 0);
      sprite.visible = false;
      this.scene.add(sprite);
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
      this.scene.add(sprite);
      this.labels.push({ sprite, life: 0 });
    }

    // A small pool of glow bursts for the pickup pop.
    for (let i = 0; i < 8; i++) {
      const sprite = makeGlow(0xfff0a8, 1, 0);
      sprite.visible = false;
      this.scene.add(sprite);
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
    this.coinRims.count = 0;
    this.coinHalos.count = 0;
    this.gems.count = 0;
    this.gemHalos.count = 0;
    this.streak = 0;
    for (const f of [...this.flyers, ...this.gemFlyers]) {
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
    this.pops.forEach((p) => {
      p.life = 0;
      p.sprite.visible = false;
    });
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
          if (this.pickups.length - this.gems.count >= MAX_COINS) break;
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
    this.coinRims.count = this.coins.count;
    this.coinHalos.count = this.coins.count;
    this.gemHalos.count = this.gems.count;
    this.writeAll(0);
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
      index: mesh.count
    });
    mesh.count += 1;
  }

  /** Write every instance matrix; spinning ones near the rider, static far away. */
  private writeAll(t: number): void {
    const here = game.distance;
    for (const p of this.pickups) {
      const mesh = p.gem ? this.gems : this.coins;
      if (p.taken) {
        this.scale.setScalar(0);
        this.matrix.compose(p.position, this.quat.identity(), this.scale);
        mesh.setMatrixAt(p.index, this.matrix);
        continue;
      }
      const near = Math.abs(p.s - here) < 90;
      const spin = near ? t * (p.gem ? 3.0 : 6.5) + p.phase : p.phase;
      this.quat.setFromAxisAngle(this.yAxis, p.yaw + spin);
      // A wave runs down each string; gems bob a little more.
      const bob = near ? Math.sin(t * 3.2 - p.s * 0.9) * (p.gem ? 0.1 : 0.06) : 0;
      this.scale.setScalar(1);
      this.matrix.compose(
        p.position,
        this.quat,
        this.scale
      );
      if (bob !== 0) this.matrix.elements[13] += bob;
      mesh.setMatrixAt(p.index, this.matrix);
    }
    this.coins.instanceMatrix.needsUpdate = true;
    this.gems.instanceMatrix.needsUpdate = true;
  }

  private collect(p: Pickup): void {
    p.taken = true;
    this.streak += 1;
    this.streakTimer = 1.4;
    game.coins += p.gem ? GEM_VALUE : 1;
    audio.coin(this.streak, p.gem);

    // Flash at the pickup point.
    const pop = this.pops.find((q) => q.life <= 0) ?? this.pops[0];
    pop.life = 0.35;
    pop.sprite.position.copy(p.position);
    pop.sprite.visible = true;
    (pop.sprite.material as { color: Color }).color.setHex(p.gem ? 0xbfffe9 : 0xfff0a8);

    // The coin itself lifts off toward the counter.
    const pool = p.gem ? this.gemFlyers : this.flyers;
    const flyer = pool.find((f) => !f.active) ?? pool[0];
    flyer.active = true;
    flyer.t = 0;
    flyer.from.copy(p.position);
    flyer.mesh.position.copy(p.position);
    flyer.mesh.scale.setScalar(1);
    flyer.mesh.visible = true;

    // Sparkles burst outward and fall.
    let spawned = 0;
    for (const s of this.sparks) {
      if (s.life > 0) continue;
      s.life = SPARK_LIFE;
      s.sprite.position.copy(p.position);
      s.velocity
        .set(Math.random() - 0.5, Math.random() * 0.6 + 0.2, Math.random() - 0.5)
        .normalize()
        .multiplyScalar(2.2 + Math.random() * 2.4);
      s.sprite.visible = true;
      (s.sprite.material as { color: Color }).color.setHex(p.gem ? 0xa8ffe4 : 0xfff1a0);
      if (++spawned >= (p.gem ? 10 : 6)) break;
    }

    // "+1" / "+5" floats up and fades.
    const label = this.labels.find((l) => l.life <= 0) ?? this.labels[0];
    label.life = LABEL_LIFE;
    label.sprite.material = p.gem ? this.labelMaterials.gem : this.labelMaterials.coin;
    label.sprite.scale.set(p.gem ? 0.9 : 0.7, p.gem ? 0.45 : 0.35, 1);
    label.sprite.position.copy(p.position).add(this.scratch.set(0, 0.35, 0));
    label.sprite.visible = true;
  }

  /**
   * Where taken coins fly to: into the HUD counter itself, so they land in
   * the number rather than hanging in front of it. Falls back to a point
   * ahead of the eyes if the panel isn't up.
   */
  private updateFlyTarget(): void {
    const hud = (this.globals.panels as { hud?: { object3D?: Object3D } } | undefined)?.hud
      ?.object3D;
    if (hud && hud.visible) {
      hud.getWorldPosition(this.flyTarget);
      this.flyTarget.y -= 0.12;
      return;
    }
    this.player.getWorldDirection(this.rigForward);
    this.flyTarget.copy(this.headWorld).addScaledVector(this.rigForward, 1.1);
    this.flyTarget.y += 0.55;
  }

  private updateEffects(delta: number): void {
    this.updateFlyTarget();
    for (const f of [...this.flyers, ...this.gemFlyers]) {
      if (!f.active) continue;
      f.t += delta;
      const k = Math.min(1, f.t / FLY_TIME);
      const ease = 1 - (1 - k) * (1 - k);
      f.mesh.position.lerpVectors(f.from, this.flyTarget, ease);
      f.mesh.position.y += Math.sin(k * Math.PI) * 0.45; // a little arc
      f.mesh.scale.setScalar(Math.max(0.001, 1 - k));
      f.mesh.rotation.y += delta * 16;
      if (k >= 1) {
        f.active = false;
        f.mesh.visible = false;
      }
    }
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
      l.sprite.position.y += delta * 1.3;
      const k = Math.max(0, l.life / LABEL_LIFE);
      (l.sprite.material as { opacity: number }).opacity = Math.min(1, k * 1.6);
      if (l.life <= 0) l.sprite.visible = false;
    }
  }

  update(delta: number, time: number): void {
    const t = time / 1000;
    this.uTime.value = t;

    // Pickup bursts: swell and fade.
    for (const pop of this.pops) {
      if (pop.life <= 0) continue;
      pop.life -= delta;
      const k = 1 - Math.max(0, pop.life) / 0.35;
      pop.sprite.scale.setScalar(0.5 + k * 2.4);
      (pop.sprite.material as { opacity: number }).opacity = (1 - k) * 0.9;
      if (pop.life <= 0) pop.sprite.visible = false;
    }

    if (this.streakTimer > 0) {
      this.streakTimer -= delta;
      if (this.streakTimer <= 0) this.streak = 0;
    }

    const env = this.world.getSystem(EnvironmentSystem);
    if (env) env.getHeadWorld(this.headWorld);
    this.updateEffects(delta);

    if (this.pickups.length === 0) return;

    // Sweep: anything whose arc-length we crossed this frame, in our lane.
    if (game.phase === 'SLIDE') {
      const slide = this.world.getSystem(SlideSystem);
      if (slide && env) {
        const lateral = slide.lateralOf(this.headWorld);
        const from = slide.previousDistance - 0.3;
        const to = slide.distance + 0.3;
        for (const p of this.pickups) {
          if (p.taken || p.s < from || p.s > to) continue;
          if (Math.abs(lateral - LANE_X[p.lane]) < CATCH_WIDTH) this.collect(p);
        }
      }
    }

    this.writeAll(t);
  }
}

// ---------------------------------------------------------------------------
// Pickup materials — bright, self-lit, cartoon-glossy.
// ---------------------------------------------------------------------------

/**
 * Coin / rim / gem surface. `mode` 0 splits a coin into a bright face and an
 * orange edge by its local normal, 1 paints everything the edge colour (the
 * bezel torus), 2 shades a gem's facets top-to-bottom. Lighting only ever
 * nudges the colour — the pickups glow on their own — and the face carries
 * a white glint crescent, a sweeping shine stripe and a view-based rim light.
 */
function createPickupMaterial(
  uTime: { value: number },
  opts: { mode: number; face: number; edge: number; radius: number }
): ShaderMaterial {
  return new ShaderMaterial({
    fog: true,
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime,
        uFace: { value: new Color(opts.face) },
        uEdge: { value: new Color(opts.edge) },
        uMode: { value: opts.mode },
        uRadius: { value: opts.radius }
      }
    ]),
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vLocalN;
      varying vec3 vWorldN;
      varying vec3 vView;
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
        vWorldN = normalize(mat3(mm) * normal);
        vView = normalize(cameraPosition - wp.xyz);
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vLocalN;
      varying vec3 vWorldN;
      varying vec3 vView;
      uniform float uTime;
      uniform vec3 uFace;
      uniform vec3 uEdge;
      uniform float uMode;
      uniform float uRadius;
      #include <fog_pars_fragment>
      ${LIGHT_GLSL}
      void main() {
        float faceness = 0.0;
        if (uMode < 0.5) faceness = smoothstep(0.4, 0.6, abs(vLocalN.z));
        else if (uMode > 1.5) faceness = smoothstep(-0.2, 0.7, vLocalN.y);
        vec3 col = mix(uEdge, uFace, faceness);

        // Sun only nudges it: bright in the light, still bright in shade.
        vec3 n = normalize(vWorldN);
        col *= 0.82 + 0.28 * celBands(dot(n, SUN_DIR));

        if (uMode < 0.5) {
          // Cartoon glint: a white crescent at the upper-left of the face.
          vec2 p = vLocal.xy / uRadius;
          float r = length(p);
          vec2 dir = p / max(r, 1e-4);
          float crescent = smoothstep(0.74, 0.92, dot(dir, normalize(vec2(-0.6, 0.8))))
                         * smoothstep(0.55, 0.72, r) * (1.0 - smoothstep(0.84, 0.92, r));
          col = mix(col, vec3(1.0, 0.99, 0.9), crescent * faceness * 0.8);
          // A shine stripe sweeping across the face.
          float band = fract((p.x + p.y) * 0.45 + uTime * 0.7);
          float stripe = smoothstep(0.0, 0.04, band) * smoothstep(0.16, 0.10, band);
          col = mix(col, vec3(1.0), stripe * faceness * 0.3);
          // Thin bright ring just inside the bezel.
          float ring = smoothstep(0.80, 0.84, r) * (1.0 - smoothstep(0.88, 0.92, r));
          col = mix(col, vec3(1.0, 0.95, 0.7), ring * faceness * 0.6);
        }

        // Rim light from the view angle.
        float rim = pow(1.0 - abs(dot(n, normalize(vView))), 3.0);
        col += vec3(1.0, 0.92, 0.7) * rim * 0.3;

        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `
  });
}

/**
 * A soft additive halo: a camera-facing quad built in the vertex shader from
 * the instance's position and scale, so it follows each pickup, ignores its
 * spin, and collapses with it when taken.
 */
function createHaloMaterial(
  uTime: { value: number },
  color: number,
  size: number
): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uTime, uColor: { value: new Color(color) }, uSize: { value: size } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      uniform float uSize;
      uniform float uTime;
      void main() {
        vUv = uv;
        #ifdef USE_INSTANCING
          mat4 mm = modelMatrix * instanceMatrix;
        #else
          mat4 mm = modelMatrix;
        #endif
        vec3 center = (mm * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float sc = length(mm[0].xyz);
        vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        float pulse = 1.0 + 0.08 * sin(uTime * 4.0 + center.y * 0.7);
        vec3 wp = center + (camRight * position.x + camUp * position.y) * uSize * sc * pulse;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform vec3 uColor;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float a = 1.0 - smoothstep(0.0, 1.0, d);
        a = a * a * 0.45;
        gl_FragColor = vec4(uColor * a, a);
        #include <colorspace_fragment>
      }
    `
  });
}
