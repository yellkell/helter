import { createSystem, Group, Vector3 } from '@iwsdk/core';

import {
  BARRIER_SPACING,
  GATE_COLORS,
  LANE_X,
  SLIDE_ACCEL_TIME,
  SLIDE_SPEED
} from '../constants.js';
import { createGate } from '../env/track.js';
import { HelterPath, helterPath, type PathSample } from '../ride/path.js';
import { emit, game, on } from '../state.js';

/**
 * Gate patterns per tier: each entry is the set of lanes blocked at that
 * gate. Single-lane gates leave two ways through; double-lane gates force
 * one specific opening. (DOWN's patterns, verbatim.)
 */
const PATTERNS: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>> = [
  [[0], [1], [2], [0], [2], [1]],
  [[0], [2], [0, 1], [1], [1, 2], [0], [0, 2], [2]],
  [[1], [0, 1], [2], [0], [1, 2], [0, 2], [1], [2], [0, 1]]
];

export interface Gate {
  group: Group;
  /** Arc-length position along the slide. */
  s: number;
  tier: number;
  /** Lane index (0 outer .. 2 tower side) this board blocks. */
  lane: number;
}

/**
 * DOWN's slide system on a spiral: the rig rides the helix by arc length —
 * eased launch, then full speed all the way into a hard stop at the landing.
 * The rig yaws to keep facing downhill, so "lean left / right" stays
 * left / right in the player's own body no matter where on the spiral they
 * are. Gates for the whole ride are stood up at game start so the course is
 * visible from the balcony.
 */
export class SlideSystem extends createSystem({}) {
  private active = false;
  private tierIndex = 0;
  private s = 0;
  private prevS = 0;
  private endS = 0;
  private speed = 0;
  private elapsed = 0;
  private gates: Gate[] = [];
  private sample: PathSample = HelterPath.makeSample();
  private course = new Group();

  init(): void {
    this.scene.add(this.course);
    on('game-over', () => this.endSlide());
    on('game-reset', () => {
      this.endSlide();
      this.clearGates();
    });
  }

  getGates(): Gate[] {
    return this.gates;
  }

  /** Distance ridden so far along the whole slide. */
  get distance(): number {
    return this.s;
  }

  /** Where the rig was at the start of this frame — for sweep tests. */
  get previousDistance(): number {
    return this.prevS;
  }

  /**
   * How far a world point sits across the slide from the rig's centreline,
   * in metres: negative toward the outer lip, positive toward the tower.
   * Lanes live at -0.5 / 0 / +0.5, same as DOWN.
   */
  lateralOf(world: Vector3): number {
    return (
      (world.x - this.sample.position.x) * this.sample.right.x +
      (world.z - this.sample.position.z) * this.sample.right.z
    );
  }

  /** Put the rig at the very start of the slide, facing downhill. */
  placeAtStart(): void {
    this.s = 0;
    this.prevS = 0;
    this.applyPose(0);
  }

  /** Place the rig on the path at arc length `s`, floor on the slide bed. */
  private applyPose(s: number): void {
    helterPath.sample(s, this.sample);
    this.player.position.copy(this.sample.position);
    this.player.rotation.set(0, this.sample.yaw, 0);
  }

  /** Stand up every gate on every tier. */
  buildCourse(): void {
    this.clearGates();
    helterPath.tiers.forEach((tier, i) => {
      const spacing = BARRIER_SPACING[Math.min(i, BARRIER_SPACING.length - 1)];
      const pattern = PATTERNS[Math.min(i, PATTERNS.length - 1)];
      const helixLength = tier.helixS1 - tier.helixS0;
      // No gates in the final stretch — leave room to land. And none in the
      // first few metres, so the launch is clean.
      const count = Math.floor((helixLength - 12) / spacing);
      for (let k = 1; k <= count; k++) {
        const s = tier.helixS0 + 4 + k * spacing;
        const lanes = pattern[k % pattern.length];
        const color = GATE_COLORS[Math.floor(Math.random() * GATE_COLORS.length)];
        for (const lane of lanes) {
          this.gates.push({ group: this.spawnGate(s, LANE_X[lane], color), s, tier: i, lane });
        }
      }
    });
  }

  private spawnGate(s: number, lateral: number, color: number): Group {
    const sample = helterPath.sample(s, HelterPath.makeSample());
    const gate = createGate(color);
    gate.position.copy(sample.position).addScaledVector(sample.right, lateral);
    gate.position.y += 1.3; // board is centred; stand it on the bed
    gate.rotation.y = sample.yaw;
    this.course.add(gate);
    return gate;
  }

  private clearGates(): void {
    this.gates.forEach((g) => g.group.removeFromParent());
    this.gates = [];
  }

  /** Kick off a tier from wherever the rig currently is. */
  begin(tierIndex: number): void {
    const tier = helterPath.tiers[tierIndex];
    if (!tier) return;
    this.active = true;
    this.tierIndex = tierIndex;
    this.s = tier.s0;
    this.prevS = tier.s0;
    this.endS = tier.s1;
    this.speed = 0;
    this.elapsed = 0;
    emit('slide-start');
  }

  endSlide(): void {
    this.active = false;
    game.slideSpeed = 0;
  }

  update(delta: number): void {
    if (!this.active) return;

    this.elapsed += delta;

    // Ease in for comfort — then full speed all the way into the landing.
    // No end-of-slide braking: the arrival shockwave sells the stop, and a
    // hard cut reads better in VR than a long decel.
    const launch = Math.min(1, this.elapsed / SLIDE_ACCEL_TIME);
    this.speed = SLIDE_SPEED * launch * launch;
    game.slideSpeed = this.speed;

    this.prevS = this.s;
    this.s += this.speed * delta;
    game.distance = this.s;

    if (this.s >= this.endS - 0.01) {
      this.s = this.endS;
      this.applyPose(this.s);
      this.active = false;
      game.slideSpeed = 0;
      const isFinal = this.tierIndex >= helterPath.tiers.length - 1;
      emit(isFinal ? 'final-slide-complete' : 'slide-complete');
      return;
    }
    this.applyPose(this.s);
  }
}
