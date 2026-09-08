import { Vector3 } from '@iwsdk/core';

import {
  BAY_ARRIVAL,
  BAY_RUN,
  GROUND_LANDING_Y,
  SLIDE_PITCH,
  SLIDE_RADIUS,
  TIER_HEIGHTS
} from '../constants.js';

/** A point on the slide: where the rig's floor is and which way is downhill. */
export interface PathSample {
  position: Vector3;
  /** Unit vector along the slide (horizontal + downhill), the rig's -Z. */
  forward: Vector3;
  /** Unit horizontal vector to the rider's right — points at the tower. */
  right: Vector3;
  /** Rig yaw (radians about +Y) that points the rig's -Z along `forward`. */
  yaw: number;
  /** Angle around the tower axis (radians). */
  angle: number;
  /** True while on a flat landing bay rather than the descending helix. */
  flat: boolean;
}

interface Segment {
  /** Arc-length where this segment starts. */
  s0: number;
  length: number;
  angle0: number;
  y0: number;
  /** Vertical drop per metre of arc (0 on the flat bays). */
  slope: number;
  /** Radians of tower angle per metre of arc. */
  turn: number;
}

export interface Tier {
  index: number;
  /** Arc-length span of the whole tier (run-up + helix + arrival). */
  s0: number;
  s1: number;
  /** Arc-length span of the descending helix only — where gates live. */
  helixS0: number;
  helixS1: number;
}

/**
 * The line the rig rides: a helix around the tower, broken into tiers.
 * Each tier is a flat run-up along the landing bay, the descending spiral,
 * then a short flat arrival strip where the rig stops dead.
 *
 * Everything is parametrised by arc length `s` (metres along the slide),
 * which is exactly what DOWN's slide system integrates: speed × dt.
 */
export class HelterPath {
  readonly segments: Segment[] = [];
  readonly tiers: Tier[] = [];
  readonly totalLength: number;

  constructor() {
    const sinP = Math.sin(SLIDE_PITCH);
    const cosP = Math.cos(SLIDE_PITCH);
    let s = 0;
    let angle = Math.PI / 2; // start on the seaward side of the balcony
    let y = TIER_HEIGHTS[0];

    const push = (length: number, slope: number, turn: number): void => {
      this.segments.push({ s0: s, length, angle0: angle, y0: y, slope, turn });
      s += length;
      angle += turn * length;
      y -= slope * length;
    };

    for (let i = 0; i < TIER_HEIGHTS.length; i++) {
      const top = TIER_HEIGHTS[i];
      const bottom = i + 1 < TIER_HEIGHTS.length ? TIER_HEIGHTS[i + 1] : GROUND_LANDING_Y;
      const tierS0 = s;
      push(BAY_RUN, 0, 1 / SLIDE_RADIUS);
      const helixS0 = s;
      const helixLength = (top - bottom) / sinP;
      push(helixLength, sinP, cosP / SLIDE_RADIUS);
      const helixS1 = s;
      push(BAY_ARRIVAL, 0, 1 / SLIDE_RADIUS);
      this.tiers.push({ index: i, s0: tierS0, s1: s, helixS0, helixS1 });
    }
    this.totalLength = s;
  }

  private segmentAt(s: number): Segment {
    const segs = this.segments;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (s >= segs[i].s0) return segs[i];
    }
    return segs[0];
  }

  /** Where the first tier's flat run-up ends and the spiral begins. */
  helixStart(): number {
    return this.tiers[0].helixS0;
  }

  sample(s: number, out: PathSample): PathSample {
    const clamped = Math.max(0, Math.min(this.totalLength, s));
    const seg = this.segmentAt(clamped);
    const ds = clamped - seg.s0;
    const angle = seg.angle0 + seg.turn * ds;
    const y = seg.y0 - seg.slope * ds;

    out.angle = angle;
    out.flat = seg.slope === 0;
    out.position.set(Math.cos(angle) * SLIDE_RADIUS, y, Math.sin(angle) * SLIDE_RADIUS);

    // Horizontal tangent for increasing angle, scaled by how much of the
    // arc is horizontal, then the vertical drop.
    const horiz = seg.turn * SLIDE_RADIUS; // = cos(pitch) on the helix, 1 on the flats
    out.forward.set(-Math.sin(angle) * horiz, -seg.slope, Math.cos(angle) * horiz).normalize();
    out.right.set(-Math.cos(angle), 0, -Math.sin(angle));
    out.yaw = Math.atan2(-out.forward.x, -out.forward.z);
    return out;
  }

  static makeSample(): PathSample {
    return {
      position: new Vector3(),
      forward: new Vector3(),
      right: new Vector3(),
      yaw: 0,
      angle: 0,
      flat: true
    };
  }
}

/** One shared path — the slide is built once and ridden many times. */
export const helterPath = new HelterPath();
