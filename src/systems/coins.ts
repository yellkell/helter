import {
  Color,
  createSystem,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  OctahedronGeometry,
  Quaternion,
  Sprite,
  Vector3
} from '@iwsdk/core';

import { LANE_X, PAINT } from '../constants.js';
import { makeGlow } from '../env/fx.js';
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
  private pickups: Pickup[] = [];
  private pops: Pop[] = [];
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
    this.coins = new InstancedMesh(
      coinGeo,
      new MeshLambertMaterial({ color: 0xffc93c, emissive: 0x7a5200 }),
      MAX_COINS
    );
    const gemGeo = new OctahedronGeometry(0.26);
    gemGeo.scale(0.8, 1.25, 0.8);
    this.gems = new InstancedMesh(
      gemGeo,
      new MeshLambertMaterial({ color: PAINT.mint, emissive: 0x1b6f5c }),
      MAX_GEMS
    );
    for (const mesh of [this.coins, this.gems]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.scene.add(mesh);
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
    this.gems.count = 0;
    this.streak = 0;
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
      const near = Math.abs(p.s - here) < 80;
      const spin = near ? t * (p.gem ? 2.2 : 4.0) + p.phase : p.phase;
      this.quat.setFromAxisAngle(this.yAxis, p.yaw + spin);
      const bob = near && p.gem ? Math.sin(t * 3 + p.phase) * 0.08 : 0;
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

    const pop = this.pops.find((q) => q.life <= 0) ?? this.pops[0];
    pop.life = 0.35;
    pop.sprite.position.copy(p.position);
    pop.sprite.visible = true;
    (pop.sprite.material as { color: Color }).color.setHex(p.gem ? 0xbfffe9 : 0xfff0a8);
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

    this.writeAll(t);
  }
}
