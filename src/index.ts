import {
  ACESFilmicToneMapping,
  Fog,
  Interactable,
  PanelUI,
  ReferenceSpaceType,
  SessionMode,
  VisibilityState,
  World
} from '@iwsdk/core';

import { audio } from './audio.js';
import { FOG_COLOR } from './constants.js';
import { createFairground } from './env/fairground.js';
import { Confetti } from './env/fx.js';
import { createSea } from './env/sea.js';
import { createSky } from './env/sky.js';
import { createTerrain } from './env/terrain.js';
import { createTower } from './env/tower.js';
import { createSlideTrack, createStreaks } from './env/track.js';
import { helterPath } from './ride/path.js';
import { CoinSystem } from './systems/coins.js';
import { EnvironmentSystem, type EnvHandles } from './systems/environment.js';
import { GameSystem, type PanelEntities } from './systems/game.js';
import { SlideSystem } from './systems/slide.js';

World.create(document.getElementById('scene-container') as HTMLDivElement, {
  xr: {
    sessionMode: SessionMode.ImmersiveVR,
    referenceSpace: { type: ReferenceSpaceType.LocalFloor },
    offer: 'always'
  },
  render: {
    // A 0.3 m near plane (not 0.1) triples depth precision at range: from
    // 300 m up, the beach and the sea a hair apart used to fight and flicker.
    near: 0.3,
    far: 9000,
    defaultLighting: false,
    // Desktop rider's eye: standing on the slide, looking down it.
    camera: { position: [0, 1.65, 0.35], lookAt: [0, -0.4, -4.5] }
  },
  features: {
    locomotion: false,
    grabbing: false,
    spatialUI: true
  }
}).then((world) => {
  // Three.js defaults WebXR to maximum fixed foveation, which shows as a
  // head-locked dark band on Quest in high-contrast scenes.
  world.renderer.xr.setFoveation(0);
  world.renderer.toneMapping = ACESFilmicToneMapping;
  world.renderer.toneMappingExposure = 1.0;

  const { scene, player } = world;

  // Coastal haze: near things crisp, the far hills and the horizon milky.
  scene.fog = new Fog(FOG_COLOR, 500, 4800);

  // --- The world ---------------------------------------------------------
  const sky = createSky();
  scene.add(sky.group);

  const terrain = createTerrain();
  scene.add(terrain.group);

  const sea = createSea();
  scene.add(sea.group);

  const tower = createTower();
  scene.add(tower.group);

  const track = createSlideTrack(helterPath);
  scene.add(track.group);

  const fair = createFairground(terrain.heightAt);
  scene.add(fair.group);

  const streaks = createStreaks();
  player.add(streaks.object);

  const confetti = new Confetti();
  scene.add(confetti.mesh);

  world.globals.env = {
    sky,
    sea,
    tower,
    track,
    fair,
    streaks,
    confetti
  } satisfies EnvHandles;

  // --- UI panels (compiled from ui/*.uikitml) -----------------------------
  // In-VR start lobby — parked below until the player enters VR, then shown
  // so they press BEGIN themselves (the ride never auto-starts in VR).
  const startPanel = world
    .createTransformEntity(undefined, world.playerEntity)
    .addComponent(PanelUI, { config: './ui/start.json', maxWidth: 1.35, maxHeight: 1.9 })
    .addComponent(Interactable);
  startPanel.object3D!.position.set(0, -9999, -1.9);

  // The HUD and the warning banner are never visibility-toggled either: a
  // panel that sat invisible from boot came up blank the first time it was
  // shown in the headset. Like the menus, they stay live and park far below
  // the world until the game places them.
  const hudPanel = world
    .createTransformEntity(undefined, world.playerEntity)
    .addComponent(PanelUI, { config: './ui/hud.json', maxWidth: 1.1, maxHeight: 0.75 });
  hudPanel.object3D!.position.set(0, -9999, -3.6);
  hudPanel.object3D!.rotation.x = 0.14;

  // The end panel stays live from boot (visibility-toggling a panel can
  // leave its ray interaction stale) — it parks far below until needed.
  const endPanel = world
    .createTransformEntity(undefined, world.playerEntity)
    .addComponent(PanelUI, { config: './ui/end.json', maxWidth: 1.3, maxHeight: 1.1 })
    .addComponent(Interactable);
  endPanel.object3D!.position.set(0, -9999, -1.8);

  const warnPanel = world
    .createTransformEntity(undefined, world.playerEntity)
    .addComponent(PanelUI, { config: './ui/warn.json', maxWidth: 2.2, maxHeight: 0.5 });
  warnPanel.object3D!.position.set(0, -9999, -2.6);
  warnPanel.object3D!.rotation.x = -0.25;

  world.globals.panels = {
    start: startPanel,
    hud: hudPanel,
    end: endPanel,
    warn: warnPanel
  } satisfies PanelEntities;

  // --- Game --------------------------------------------------------------
  audio.init();
  world
    .registerSystem(EnvironmentSystem)
    .registerSystem(SlideSystem)
    .registerSystem(CoinSystem)
    .registerSystem(GameSystem);

  // Stand the rider on the balcony, facing down the slide, from the start.
  world.getSystem(SlideSystem)?.placeAtStart();

  // --- 2D intro / entry ---------------------------------------------------
  const game = world.getSystem(GameSystem);
  const intro = document.getElementById('intro');
  const enterVrBtn = document.getElementById('enter-vr');
  const previewBtn = document.getElementById('play-browser');
  const vrStatus = document.getElementById('vr-status');
  const wordmark = document.getElementById('wordmark');
  const hint = document.getElementById('hint');

  let dismissed = false;
  const dismissIntro = (): void => {
    if (dismissed) return;
    dismissed = true;
    intro?.classList.add('gone');
    window.setTimeout(() => intro?.remove(), 700);
    wordmark?.removeAttribute('hidden');
    hint?.removeAttribute('hidden');
  };

  // ENTER VR: request the session. Once it's visible, the in-VR lobby
  // appears and the player presses BEGIN there.
  enterVrBtn?.addEventListener('click', () => {
    if (enterVrBtn.classList.contains('disabled')) return;
    // This click is the page's one guaranteed DOM gesture — resume the
    // audio context here so WebAudio SFX are unlocked before the session,
    // where UIKit button clicks don't count as gestures.
    audio.unlock();
    world.launchXR();
  });
  // RIDE IN BROWSER: desktop rider with keyboard lean — starts straight away.
  previewBtn?.addEventListener('click', () => {
    audio.unlock();
    dismissIntro();
    game?.beginRun();
  });
  world.visibilityState.subscribe((state) => {
    if (state !== VisibilityState.NonImmersive) {
      dismissIntro();
      game?.showStartLobby();
    }
  });

  // Reveal the intro now that the world is ready.
  const loading = document.getElementById('loading');
  loading?.classList.add('done');
  window.setTimeout(() => loading?.remove(), 700);
  intro?.removeAttribute('hidden');

  // Probe for a headset to tailor the call-to-action.
  const xr = (navigator as Navigator & {
    xr?: { isSessionSupported(mode: string): Promise<boolean> };
  }).xr;
  const noHeadset = (msg: string): void => {
    enterVrBtn?.classList.add('disabled');
    if (vrStatus) vrStatus.textContent = msg;
  };
  if (xr?.isSessionSupported) {
    xr.isSessionSupported('immersive-vr')
      .then((ok) => {
        if (ok) {
          if (vrStatus) vrStatus.textContent = 'Headset ready — clear a 2m × 2m space';
        } else {
          noHeadset('No headset detected — ride in your browser');
        }
      })
      .catch(() => noHeadset('No headset detected — ride in your browser'));
  } else {
    noHeadset('WebXR not available — ride in your browser');
  }
});
