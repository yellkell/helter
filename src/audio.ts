/**
 * Audio, played via HTMLAudio (reliable inside WebXR sessions on Quest
 * browser; the BEGIN button click provides the unlock gesture).
 *
 * The soundtrack and stingers are DOWN's. All paths are relative so the game
 * works from a subpath (GitHub Pages).
 */
const SFX = {
  begin: './audio/begin.ogg',
  die: './audio/die.ogg',
  gameover: './audio/gameover.ogg',
  square: './audio/square.ogg',
  nice: './audio/nice.wav',
  perfect: './audio/perfect.wav',
  welldone: './audio/welldone.wav'
} as const;

export type SfxName = keyof typeof SFX;

class AudioManager {
  private sfx = new Map<SfxName, HTMLAudioElement>();
  private music: HTMLAudioElement | null = null;

  init(): void {
    (Object.keys(SFX) as SfxName[]).forEach((name) => {
      const el = new Audio(SFX[name]);
      el.preload = 'auto';
      this.sfx.set(name, el);
    });
    // AAC where supported, Vorbis everywhere else (open-codec Chromium
    // builds ship without AAC — no browser should ever lose the music).
    const probe = document.createElement('audio');
    const src = probe.canPlayType('audio/mp4; codecs="mp4a.40.2"')
      ? './audio/run.m4a'
      : './audio/run.ogg';
    this.music = new Audio(src);
    this.music.preload = 'auto';
    this.music.loop = true;
    this.music.volume = 0.5;
  }

  play(name: SfxName, volume = 1): void {
    const el = this.sfx.get(name);
    if (!el) return;
    el.currentTime = 0;
    el.volume = volume;
    void el.play().catch(() => {});
  }

  startMusic(): void {
    if (!this.music) return;
    this.music.currentTime = 0;
    void this.music.play().catch(() => {});
  }

  stopMusic(): void {
    this.music?.pause();
  }
}

export const audio = new AudioManager();
