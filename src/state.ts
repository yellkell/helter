/**
 * Shared game state + a tiny event bus.
 * Systems read/write this instead of poking at each other directly.
 */
export type Phase = 'START' | 'LANDING' | 'SLIDE' | 'WIN' | 'GAME_OVER';

export const game = {
  phase: 'START' as Phase,
  /** 1-based tier being ridden (1..TOTAL_TIERS). */
  tier: 1,
  /** Seconds elapsed in the current phase. */
  timeInPhase: 0,
  /** Seconds since BEGIN, for the end-screen stat. */
  runTime: 0,
  /** Set to 1 when a tier lands; decays to 0, driving the bay shockwave. */
  arrival: 0,
  /** Seconds left standing on the landing before the next launch. */
  holdRemaining: 0,
  /** Current slide speed in m/s, drives the wind streaks. */
  slideSpeed: 0,
  /** Distance ridden along the whole slide, in metres. */
  distance: 0
};

export type GameEvent =
  | 'game-start'
  | 'slide-start'
  | 'slide-complete'
  | 'final-slide-complete'
  | 'game-over'
  | 'game-reset';

const listeners = new Map<GameEvent, Set<() => void>>();

export function on(event: GameEvent, cb: () => void): void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
}

export function emit(event: GameEvent): void {
  listeners.get(event)?.forEach((cb) => cb());
}

export function resetGameState(): void {
  game.phase = 'START';
  game.tier = 1;
  game.timeInPhase = 0;
  game.runTime = 0;
  game.arrival = 0;
  game.holdRemaining = 0;
  game.slideSpeed = 0;
  game.distance = 0;
}
