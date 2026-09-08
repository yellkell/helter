/**
 * Central tuning for HELTER SKELTER.
 *
 * The ride: one gigantic seaside helter skelter. You start on the balcony at
 * the top of a 300m striped tower and ride the slide that spirals around it
 * in three tiers (300m → 200m → 100m → ground), stopping on a landing bay
 * between tiers to catch your breath before the next drop launches.
 *
 * The sliding itself is DOWN's: eased launch, constant speed along the
 * slide, lean left / right between the gates, a hard stop with a shockwave
 * at every landing. The only thing that changed is the line you ride — a
 * helix instead of a straight 32° drop.
 */

/** Slide heights: the top of each tier, then the ground landing. */
export const TIER_HEIGHTS = [300, 200, 100];
export const GROUND_LANDING_Y = 0.6; // the exit bay sits on a low plinth
export const TOTAL_TIERS = TIER_HEIGHTS.length;

/** Total vertical descent, balcony to exit (drives the end-screen stat). */
export const TOTAL_DESCENT = Math.round(TIER_HEIGHTS[0] - GROUND_LANDING_Y);

const params =
  typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;

/** `?turbo` shortens the landing holds — handy when testing the win flow. */
export const IS_TURBO = params?.has('turbo') ?? false;
/** `?calm` rides at two-thirds speed for a gentler spin. */
export const IS_CALM = params?.has('calm') ?? false;
/** `?ghost` turns the gates into scenery — just ride, nothing can stop you. */
export const IS_GHOST = params?.has('ghost') ?? false;
/** `?view=wide` parks the desktop camera out on the coast, looking at the tower. */
export const VIEW_MODE = params?.get('view') ?? '';

/** The helix the rig rides: centerline radius and how steeply it drops. */
export const SLIDE_RADIUS = 18; // metres from the tower axis to the middle of the slide
export const SLIDE_PITCH = 26 * (Math.PI / 180); // slope along the slide's own arc
export const SLIDE_SPEED = IS_CALM ? 13 : 20; // m/s along the slide (DOWN's speed)
export const SLIDE_ACCEL_TIME = 1.2; // ease-in seconds for comfort

/** Flat run-up at the start of every tier, and a flat arrival strip at its end. */
export const BAY_RUN = 7;
export const BAY_ARRIVAL = 2.5;

/** Seconds standing on a landing before the next tier launches (3-2-1 beeps). */
export const LANDING_HOLD = IS_TURBO ? 1.5 : 3.4;

/** The slide trough: bed width and lip heights. */
export const TRACK_WIDTH = 2.4;
export const OUTER_LIP = 0.95;
export const INNER_LIP = 0.42;

/** The tower the slide wraps. Its wall sits just inside the slide's inner edge. */
export const TOWER_RADIUS = SLIDE_RADIUS - TRACK_WIDTH / 2 - 0.4;
export const TOWER_TOP = TIER_HEIGHTS[0] + 16; // wall continues above the balcony
export const ROOF_HEIGHT = 34;

/**
 * Gates ("barriers"): lane offsets across the 3-lane slide. Lanes are spread
 * to ±0.5m so the boards still leave a clear gap to lean into.
 */
export const LANE_X = [-0.5, 0, 0.5];
export const BARRIER_SIZE = { w: 0.42, h: 2.6, d: 0.22 };
export const BARRIER_SPACING = [16, 13, 11]; // per tier — tightens on the way down

export const HEAD_RADIUS = 0.12;

/** Sun direction (world space, unit length) shared by every lit shader. */
export const SUN_DIR = { x: 0.38, y: 0.6, z: 0.7 };
{
  const l = Math.hypot(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z);
  SUN_DIR.x /= l;
  SUN_DIR.y /= l;
  SUN_DIR.z /= l;
}

/** Seaside palette. */
export const PAINT = {
  red: 0xe8322e,
  darkRed: 0xa5201d,
  cream: 0xfff4e0,
  gold: 0xf4c542,
  sea: 0x1e6f9e,
  ink: 0x1a1614,
  mint: 0x7fd1b9,
  sky: 0x5fb3e6
};

export const GATE_COLORS = [PAINT.red, PAINT.sea, PAINT.gold, PAINT.mint];
export const FOG_COLOR = 0xd3e3ef;
