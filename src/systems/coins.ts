import {
  Color,
  createSystem,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  OctahedronGeometry,
  Quaternion,
  TorusGeometry,
  Sprite,
  SpriteMaterial,
  Vector3
} from '@iwsdk/core';

import { LANE_X, PAINT } from '../constants.js';
import { makeGlow, makeTextTexture, toon } from '../env/fx.js';
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
    const coinMaterial = toon({ color: 0xffc93c, emissive: 0x8a5a00 });
    const rimMaterial = toon({ color: 0xb8801a, emissive: 0x3a2400 });
    const gemMaterial = toon({ color: PAINT.mint, emissive: 0x1b6f5c });
    this.coins = new InstancedMesh(coinGeo, coinMaterial, MAX_COINS);
    // A darker gold rim, real geometry, so the coin keeps its edge from any
    // angle — a pushed-out ink hull only ever showed at the silhouette.
    const rimGeo = new TorusGeometry(0.265, 0.045, 8, 28);
    this.coinRims = new InstancedMesh(rimGeo, rimMaterial, MAX_COINS);
    this.coinRims.instanceMatrix = this.coins.instanceMatrix;
    const gemGeo = new OctahedronGeometry(0.26);
    gemGeo.scale(0.8, 1.25, 0.8);
    this.gems = new InstancedMesh(gemGeo, gemMaterial, MAX_GEMS);
    for (const mesh of [this.coins, this.coinRims, this.gems]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.scene.add(mesh);
    }

    // Flyers: the coin you just took, spinning up toward the counter.
    for (let i = 0; i < 10; i++) {
      const mesh = new Mesh(coinGeo, coinMaterial);
      mesh.add(new Mesh(rimGeo, rimMaterial));
      mesh.visible = false;
      this.scene.add(mesh);
      this.flyers.push({ mesh, from: new Vector3(), t: 0, active: false });
    }
    for (let i = 0; i < 3; i++) {
      const mesh = new Mesh(gemGeo, gemMaterial);
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
    this.gems.count = 0;
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
