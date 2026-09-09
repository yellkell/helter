import {
  createSystem,
  eq,
  PanelDocument,
  PanelUI,
  RayDisplayMode,
  UIKit,
  UIKitDocument,
  Vector3,
  VisibilityState,
  type Entity
} from '@iwsdk/core';

import { audio } from '../audio.js';
import {
  BARRIER_SIZE,
  GROUND_LANDING_Y,
  HEAD_RADIUS,
  IS_GHOST,
  LANDING_HOLD,
  TOTAL_DESCENT,
  TOTAL_TIERS
} from '../constants.js';
import { emit, game, on, resetGameState } from '../state.js';
import { CoinSystem } from './coins.js';
import { EnvironmentSystem, type EnvHandles } from './environment.js';
import { SlideSystem } from './slide.js';

export interface PanelEntities {
  start: Entity;
  hud: Entity;
  end: Entity;
  warn: Entity;
}

/**
 * The referee: phase state machine, gate collisions, HUD text, countdowns,
 * audio stingers, and the win / lose panels.
 */
export class GameSystem extends createSystem({
  startPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', './ui/start.json')]
  },
  hudPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', './ui/hud.json')]
  },
  endPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', './ui/end.json')]
  },
  warnPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', './ui/warn.json')]
  }
}) {
  private headWorld = new Vector3();
  private headLocal = new Vector3();

  private hudTier: UIKit.Text | null = null;
  private hudCoins: UIKit.Text | null = null;
  private hudBig: UIKit.Text | null = null;
  private hudAlt: UIKit.Text | null = null;
  private hudStatus: UIKit.Text | null = null;
  private warnText: UIKit.Text | null = null;
  private endTitle: UIKit.Text | null = null;
  private endStats: UIKit.Text | null = null;

  private hudCache: Record<string, string> = {};
  private warnTimer = 0;
  private beepAt = 0;
  private started = false;
  /** Seconds since the end panel appeared — arms the trigger-retry. */
  private endArm = 0;
  /** In-VR start lobby is up, waiting for BEGIN. */
  private lobbyActive = false;
  /** Seconds since the lobby appeared — arms the trigger-to-begin. */
  private lobbyArm = 0;
  /** Post-win celebration beat before the end panel rises. */
  private winWait = 0;

  private get panels(): PanelEntities {
    return this.globals.panels as PanelEntities;
  }

  private get env(): EnvHandles {
    return this.globals.env as EnvHandles;
  }

  init(): void {
    this.wireStartPanel();
    this.wireHudPanel();
    this.wireEndPanel();
    this.wireWarnPanel();

    on('slide-complete', () => this.onTierComplete());
    on('final-slide-complete', () => this.onWin());

    // Desktop: Enter / Space start or retry, mirroring the trigger shortcuts.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (game.phase === 'START' && this.lobbyActive) this.startGame();
      else if ((game.phase === 'WIN' || game.phase === 'GAME_OVER') && this.winWait <= 0 && this.endArm > 0.6) {
        this.retry();
      }
    });
  }

  /** Start immediately — used by the 2D "RIDE IN BROWSER" (desktop). */
  beginRun(): void {
    this.startGame();
  }

  /**
   * Show the in-VR lobby and wait for BEGIN — the ride does NOT auto-start
   * on entering VR. Called once the immersive session becomes visible.
   */
  showStartLobby(): void {
    if (this.started) return;
    this.lobbyActive = true;
    this.lobbyArm = 0;
    this.setStartPanelShown(true);
    this.setPointersVisible(true);
  }

  /**
   * Controller laser pointers are only wanted when a menu is up — otherwise
   * they hover over the whole experience. Force the display mode by state.
   */
  private setPointersVisible(visible: boolean): void {
    const mode = visible ? RayDisplayMode.Visible : RayDisplayMode.Invisible;
    const pointers = this.input.xr.multiPointers;
    (['left', 'right'] as const).forEach((hand) => {
      const rp = (pointers[hand] as unknown as { ray?: { rayDisplayMode: RayDisplayMode } })
        .ray;
      if (rp) rp.rayDisplayMode = mode;
    });
  }

  // -- Panel wiring ---------------------------------------------------------

  private getDocument(entity: Entity): UIKitDocument | null {
    return (PanelDocument.data.document[entity.index] as UIKitDocument) ?? null;
  }

  private wireStartPanel(): void {
    this.queries.startPanel.subscribe('qualify', (entity) => {
      const doc = this.getDocument(entity);
      if (!doc) return;
      const beginBtn = doc.getElementById('begin-btn') as UIKit.Text;
      beginBtn?.addEventListener('click', () => this.startGame());
    });
  }

  private wireHudPanel(): void {
    this.queries.hudPanel.subscribe('qualify', (entity) => {
      const doc = this.getDocument(entity);
      if (!doc) return;
      this.hudTier = doc.getElementById('tier-label') as UIKit.Text;
      this.hudCoins = doc.getElementById('coin-label') as UIKit.Text;
      this.hudBig = doc.getElementById('big-label') as UIKit.Text;
      this.hudAlt = doc.getElementById('alt-label') as UIKit.Text;
      this.hudStatus = doc.getElementById('status-label') as UIKit.Text;
    });
  }

  private wireEndPanel(): void {
    this.queries.endPanel.subscribe('qualify', (entity) => {
      const doc = this.getDocument(entity);
      if (!doc) return;
      this.endTitle = doc.getElementById('end-title') as UIKit.Text;
      this.endStats = doc.getElementById('end-stats') as UIKit.Text;
      const retryBtn = doc.getElementById('retry-btn') as UIKit.Text;
      retryBtn?.addEventListener('click', () => this.retry());
    });
  }

  private wireWarnPanel(): void {
    this.queries.warnPanel.subscribe('qualify', (entity) => {
      const doc = this.getDocument(entity);
      if (!doc) return;
      this.warnText = doc.getElementById('warn-text') as UIKit.Text;
    });
  }

  private setPanelVisible(entity: Entity | undefined, visible: boolean): void {
    if (!entity) return;
    if (entity.object3D) entity.object3D.visible = visible;
    // ScreenSpace can re-parent the UIKit document out of our object3D,
    // so toggle the document group too.
    const doc = this.getDocument(entity);
    if (doc) doc.visible = visible;
  }

  /** Force a menu panel to draw on top of the world. */
  private bringPanelToFront(entity: Entity | undefined): void {
    const root = entity?.object3D;
    if (!root) return;
    root.traverse((node) => {
      const mesh = node as unknown as {
        isMesh?: boolean;
        isInstancedMesh?: boolean;
        material?:
          | { depthTest: boolean; depthWrite: boolean }
          | Array<{ depthTest: boolean; depthWrite: boolean }>;
        renderOrder: number;
      };
      if (!mesh.isMesh && !mesh.isInstancedMesh) return;
      mesh.renderOrder = 10000;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => {
        if (m) {
          m.depthTest = false;
          m.depthWrite = false;
        }
      });
    });
  }

  /**
   * Menu panels are never visibility-toggled — hide/re-show cycles can leave
   * a panel's interaction stale for controller rays. They stay live and
   * simply park far below the world until needed.
   */
  private setEndPanelShown(shown: boolean): void {
    const entity = this.panels?.end;
    if (!entity?.object3D) return;
    entity.object3D.position.set(0, shown ? this.menuHeight(1.45) : -9999, -1.8);
    if (shown) this.bringPanelToFront(entity);
  }

  private setStartPanelShown(shown: boolean): void {
    const entity = this.panels?.start;
    if (!entity?.object3D) return;
    entity.object3D.position.set(0, shown ? this.menuHeight(1.5) : -9999, -1.9);
    if (shown) this.bringPanelToFront(entity);
  }

  /** Menus hang at head height in VR; the desktop camera looks down the
   * slide, so they sit lower to land in the middle of the screen. */
  private menuHeight(vr: number): number {
    return this.visibilityState.value === VisibilityState.NonImmersive ? vr - 0.75 : vr;
  }

  /** Same idea for the HUD: above the eyeline in VR, top of the screen on desktop. */
  private layoutHud(): void {
    const hud = this.panels?.hud?.object3D;
    if (!hud) return;
    const desktop = this.visibilityState.value === VisibilityState.NonImmersive;
    hud.position.set(0, desktop ? 0.95 : 2.45, -3.6);
    hud.rotation.x = desktop ? -0.35 : 0.14;
    this.layoutWarn();
  }

  /**
   * The warning banner sits well clear of the HUD. It used to be pinned at
   * y 1.05 while the desktop HUD sat at 0.95 a metre further out, so "GO!"
   * and "FINAL DROP" landed straight on top of the readout and neither
   * could be read.
   */
  private layoutWarn(): void {
    const warn = this.panels?.warn?.object3D;
    if (!warn) return;
    const desktop = this.visibilityState.value === VisibilityState.NonImmersive;
    warn.position.set(0, desktop ? -0.55 : 1.15, -2.6);
    warn.rotation.x = desktop ? 0.3 : -0.18;
  }

  private setHud(key: 'tier' | 'coins' | 'big' | 'alt' | 'status', value: string): void {
    if (this.hudCache[key] === value) return;
    this.hudCache[key] = value;
    const el =
      key === 'tier'
        ? this.hudTier
        : key === 'coins'
          ? this.hudCoins
        : key === 'big'
          ? this.hudBig
          : key === 'alt'
            ? this.hudAlt
            : this.hudStatus;
    el?.setProperties({ text: value });
  }

  private showWarning(text: string, seconds: number): void {
    this.layoutWarn(); // in case the session flipped between desktop and VR
    this.warnText?.setProperties({ text });
    this.setPanelVisible(this.panels?.warn, true);
    this.warnTimer = seconds;
  }

  // -- Phase transitions ----------------------------------------------------

  private startGame(): void {
    if (this.started) return;
    this.started = true;
    this.lobbyActive = false;
    this.setStartPanelShown(false);
    audio.play('begin');
    window.setTimeout(() => audio.startMusic(), 400);
    this.layoutHud();
    this.setPanelVisible(this.panels?.hud, true);
    this.setPointersVisible(false);
    emit('game-start');
    this.buildCourse();
    this.enterLanding(LANDING_HOLD + 0.8);
  }

  /** Stand up the gates, then lay the coins through the gaps between them. */
  private buildCourse(): void {
    const slide = this.world.getSystem(SlideSystem);
    if (!slide) return;
    slide.placeAtStart();
    slide.buildCourse();
    this.world.getSystem(CoinSystem)?.build(slide.getGates());
  }

  private retry(): void {
    resetGameState();
    emit('game-reset');
    this.env?.confetti.stop();
    this.buildCourse();
    this.setEndPanelShown(false);
    this.winWait = 0;
    this.layoutHud();
    this.setPanelVisible(this.panels?.hud, true);
    this.setPointersVisible(false);
    this.hudCache = {};
    audio.play('begin');
    window.setTimeout(() => audio.startMusic(), 400);
    this.enterLanding(LANDING_HOLD + 0.8);
  }

  /**
   * Standing on a landing (or the balcony). Hold for a beat — no gates, no
   * motion — with 3-2-1 beeps, then the next tier launches.
   */
  private enterLanding(hold: number): void {
    game.phase = 'LANDING';
    game.timeInPhase = 0;
    game.holdRemaining = hold;
    this.beepAt = 3;
    this.showWarning(game.tier === 1 ? 'HOLD ON' : 'LANDED', 1.4);
  }

  private enterSlide(): void {
    game.phase = 'SLIDE';
    game.timeInPhase = 0;
    const slide = this.world.getSystem(SlideSystem);
    if (!slide) return;
    slide.begin(game.tier - 1);
    this.showWarning(game.tier >= TOTAL_TIERS ? 'FINAL DROP' : 'GO!', 1.4);
  }

  private onTierComplete(): void {
    // Escalating praise: "nice" after the first tier, "perfect" after the second.
    audio.play(game.tier === 1 ? 'nice' : 'perfect');
    game.arrival = 1; // bay shockwave — you've touched down
    this.world.getSystem(EnvironmentSystem)?.landAt(this.player.position);
    game.tier += 1;
    this.enterLanding(LANDING_HOLD);
  }

  private onWin(): void {
    game.phase = 'WIN';
    game.arrival = 1;
    this.world.getSystem(EnvironmentSystem)?.landAt(this.player.position);
    audio.play('welldone');
    this.getHead();
    this.env?.confetti.start(this.headWorld.clone());

    this.endTitle?.setProperties({ text: 'YOU MADE IT!' });
    this.endStats?.setProperties({
      text: `${TOTAL_DESCENT}M DOWN   -   ${this.formatTime(game.runTime)}   -   ${game.coins}/${game.coinsTotal} COINS`
    });
    this.setPanelVisible(this.panels?.hud, false);
    this.setPanelVisible(this.panels?.warn, false);

    // Let the landing breathe — confetti gets a few seconds before the panel.
    this.winWait = 3.2;
    this.setPointersVisible(true);
    this.endArm = 0;
  }

  private gameOver(): void {
    game.phase = 'GAME_OVER';
    audio.play('die');
    window.setTimeout(() => audio.play('gameover'), 250);
    audio.stopMusic();
    emit('game-over');

    const altitude = Math.max(0, Math.round(this.player.position.y - GROUND_LANDING_Y));
    this.endTitle?.setProperties({ text: 'OFF THE RIDE' });
    this.endStats?.setProperties({
      text: `TIER ${game.tier}/${TOTAL_TIERS}   -   ALT ${altitude}M   -   ${game.coins} COINS   -   ${this.formatTime(game.runTime)}`
    });
    this.setPanelVisible(this.panels?.hud, false);
    this.setPanelVisible(this.panels?.warn, false);
    this.setEndPanelShown(true);
    this.setPointersVisible(true);
    this.endArm = 0;
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /** Rising-edge trigger press on either XR controller. */
  private selectPressed(): boolean {
    const gamepads = this.input.xr.gamepads;
    return Boolean(gamepads.left?.getSelectStart() || gamepads.right?.getSelectStart());
  }

  private getHead(): Vector3 {
    const env = this.world.getSystem(EnvironmentSystem);
    if (env) return env.getHeadWorld(this.headWorld);
    return this.player.head.getWorldPosition(this.headWorld);
  }

  // -- Per-frame ------------------------------------------------------------

  update(delta: number): void {
    if (game.phase === 'WIN' || game.phase === 'GAME_OVER') {
      if (this.winWait > 0) {
        this.winWait -= delta;
        if (this.winWait <= 0) {
          this.setEndPanelShown(true);
          this.endArm = 0;
        }
        return;
      }
      // Escape hatch: after a short arm delay, a bare trigger pull on
      // either controller retries — no pointing at the panel required.
      this.endArm += delta;
      if (this.endArm > 1.2 && this.selectPressed()) this.retry();
      return;
    }
    if (game.phase === 'START') {
      if (this.lobbyActive) {
        this.lobbyArm += delta;
        if (this.lobbyArm > 0.8 && this.selectPressed()) this.startGame();
      }
      return;
    }

    game.runTime += delta;
    game.timeInPhase += delta;

    if (this.warnTimer > 0) {
      this.warnTimer -= delta;
      if (this.warnTimer <= 0) this.setPanelVisible(this.panels?.warn, false);
    }

    const alt = Math.max(0, Math.round(this.player.position.y - GROUND_LANDING_Y));
    this.setHud('alt', `ALT ${alt}M`);
    this.setHud('tier', game.tier >= TOTAL_TIERS ? 'FINAL TIER' : `TIER ${game.tier}/${TOTAL_TIERS}`);
    this.setHud('coins', `COINS ${game.coins}`);

    if (game.phase === 'LANDING') {
      this.updateLanding(delta);
    } else if (game.phase === 'SLIDE') {
      this.updateSlide();
    }
  }

  private updateLanding(delta: number): void {
    game.holdRemaining -= delta;
    const remaining = Math.max(0, game.holdRemaining);
    this.setHud('big', Math.ceil(remaining).toFixed(0));
    this.setHud('status', game.tier === 1 ? 'GRAB THE RAIL - LOOK DOWN THE SLIDE' : 'CATCH YOUR BREATH');
    if (remaining <= this.beepAt && this.beepAt > 0) {
      audio.play('square', 0.7);
      this.beepAt -= 1;
    }
    if (remaining <= 0) this.enterSlide();
  }

  private updateSlide(): void {
    this.setHud('big', `${Math.round(game.slideSpeed * 3.6)} KM/H`);
    this.setHud('status', 'LEAN BETWEEN THE GATES');

    const slide = this.world.getSystem(SlideSystem);
    if (!slide || IS_GHOST) return;

    // Collisions: head vs the gates just ahead / around the rig. Each gate is
    // tested in its own local frame so the box follows the spiral's yaw.
    this.getHead();
    const halfW = BARRIER_SIZE.w / 2 + 0.05 + HEAD_RADIUS;
    const halfH = BARRIER_SIZE.h / 2 + HEAD_RADIUS;
    const halfD = BARRIER_SIZE.d / 2 + 0.05 + HEAD_RADIUS;
    const here = slide.distance;
    for (const gate of slide.getGates()) {
      if (Math.abs(gate.s - here) > 3) continue;
      this.headLocal.copy(this.headWorld);
      gate.group.worldToLocal(this.headLocal);
      if (
        Math.abs(this.headLocal.x) < halfW &&
        Math.abs(this.headLocal.y) < halfH &&
        Math.abs(this.headLocal.z) < halfD
      ) {
        this.gameOver();
        return;
      }
    }
  }
}
