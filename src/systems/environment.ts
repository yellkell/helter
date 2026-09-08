import { createSystem, Vector3, VisibilityState } from '@iwsdk/core';

import { SLIDE_SPEED, VIEW_MODE } from '../constants.js';
import type { FairgroundHandles } from '../env/fairground.js';
import type { Confetti } from '../env/fx.js';
import type { SeaHandles } from '../env/sea.js';
import type { SkyHandles } from '../env/sky.js';
import type { TowerHandles } from '../env/tower.js';
import type { StreakHandles, TrackHandles } from '../env/track.js';
import { game } from '../state.js';

export interface EnvHandles {
  sky: SkyHandles;
  sea: SeaHandles;
  tower: TowerHandles;
  track: TrackHandles;
  fair: FairgroundHandles;
  streaks: StreakHandles;
  confetti: Confetti;
}

/**
 * Keeps the world alive: shader clocks, the big wheel turning, boats bobbing,
 * gulls circling, the landing shockwave, confetti physics, and the wind
 * streaks that follow slide speed. Also the desktop rider's lean.
 */
export class EnvironmentSystem extends createSystem({}) {
  private headWorld = new Vector3();
  private lean = 0;
  private leanTarget = 0;
  private keys = new Set<string>();

  private get env(): EnvHandles {
    return this.globals.env as EnvHandles;
  }

  init(): void {
    // Desktop riders lean with A / D or the arrow keys — the head is the
    // camera, so we slide the camera across the rig.
    window.addEventListener('keydown', (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Where the rider's head is: tracked in VR, the camera on desktop. */
  getHeadWorld(out: Vector3): Vector3 {
    if (this.visibilityState.value === VisibilityState.NonImmersive) {
      return this.world.camera.getWorldPosition(out);
    }
    return this.player.head.getWorldPosition(out);
  }

  /** Snap the landing ring to the rig's feet and fire it. */
  landAt(position: Vector3): void {
    const env = this.env;
    if (!env) return;
    env.track.arrivalRing.position.copy(position);
    env.track.arrivalRing.position.y += 0.05;
    env.track.arrivalRing.visible = true;
  }

  update(delta: number, time: number): void {
    const env = this.env;
    if (!env) return;

    const t = time / 1000;
    env.sky.uniforms.uTime.value = t;
    env.sea.uniforms.uTime.value = t;
    env.tower.uniforms.uTime.value = t;
    env.track.uniforms.uTime.value = t;

    // The fair.
    env.fair.wheel.rotation.z += delta * 0.12;
    env.sea.boats.forEach((boat) => {
      const phase = boat.userData.phase as number;
      boat.position.y = Math.sin(t * 0.8 + phase) * 0.35;
      boat.rotation.z = Math.sin(t * 0.6 + phase) * 0.06;
      boat.rotation.x = Math.cos(t * 0.7 + phase) * 0.04;
    });
    this.updateGulls(t);

    // Arrival shockwave: snap to 1 on landing, then decay over ~0.9s.
    const ring = env.track.arrivalRing;
    if (game.arrival > 0) {
      game.arrival = Math.max(0, game.arrival - delta / 0.9);
      const grow = 1 + (1 - game.arrival) * 5.5;
      ring.scale.set(grow, grow, 1);
      (ring.material as { opacity: number }).opacity = game.arrival * 0.9;
      ring.visible = true;
    } else if (ring.visible) {
      ring.visible = false;
    }

    // Slide speed FX (rig-anchored only — nothing head-locked).
    const speedRatio = game.slideSpeed / SLIDE_SPEED;
    const streaks = env.streaks.uniforms;
    streaks.uStrength.value += (speedRatio - streaks.uStrength.value) * Math.min(1, delta * 4);
    streaks.uOffset.value += game.slideSpeed * delta * 1.35;
    env.streaks.object.visible = streaks.uStrength.value > 0.02;

    // Debug / screenshot cameras are pinned in world space every frame.
    if (VIEW_MODE && this.visibilityState.value === VisibilityState.NonImmersive) {
      const cam = this.world.camera;
      if (cam.parent !== this.scene) this.scene.add(cam);
      if (VIEW_MODE === 'wide') {
        cam.position.set(330, 70, 420);
        cam.lookAt(0, 165, 0);
      } else {
        cam.position.set(70, 2, 95);
        cam.lookAt(0, 120, 0);
      }
      return;
    }

    // Desktop lean.
    if (this.visibilityState.value === VisibilityState.NonImmersive) {
      const left = this.keys.has('a') || this.keys.has('arrowleft');
      const right = this.keys.has('d') || this.keys.has('arrowright');
      this.leanTarget = left === right ? 0 : left ? -0.62 : 0.62;
      this.lean += (this.leanTarget - this.lean) * Math.min(1, delta * 9);
      this.world.camera.position.x = this.lean;
    }

    this.getHeadWorld(this.headWorld);
    env.confetti.update(delta, this.headWorld);
  }

  private updateGulls(t: number): void {
    const env = this.env;
    const gulls = env.fair.gulls;
    const m = gulls.instanceMatrix;
    const arr = m.array as Float32Array;
    env.fair.gullSeeds.forEach((seed, i) => {
      const speed = 0.12 + (seed % 7) * 0.012;
      const a = t * speed + seed;
      const radius = 40 + (seed % 60);
      const y = 60 + (seed % 230) + Math.sin(t * 0.7 + seed) * 6;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      // Face along the circle, flap by rolling.
      const yaw = -a;
      const roll = Math.sin(t * 9 + seed) * 0.5;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const cr = Math.cos(roll);
      const sr = Math.sin(roll);
      const o = i * 16;
      // Column-major: rotation = Ry(yaw) * Rz(roll)
      arr[o] = cy * cr;
      arr[o + 1] = sr;
      arr[o + 2] = -sy * cr;
      arr[o + 3] = 0;
      arr[o + 4] = -cy * sr;
      arr[o + 5] = cr;
      arr[o + 6] = sy * sr;
      arr[o + 7] = 0;
      arr[o + 8] = sy;
      arr[o + 9] = 0;
      arr[o + 10] = cy;
      arr[o + 11] = 0;
      arr[o + 12] = x;
      arr[o + 13] = y;
      arr[o + 14] = z;
      arr[o + 15] = 1;
    });
    m.needsUpdate = true;
  }
}
