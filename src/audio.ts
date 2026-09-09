/**
 * Audio. Two transports, deliberately (this is DOWN's arrangement):
 *
 * - SFX/voice lines: WebAudio buffers. HTMLAudio elements proved flaky for
 *   one-shots inside Quest's XR sessions — playback silently paused or
 *   never started depending on element state and activation timing. A
 *   decoded AudioBuffer fired through the context (the same context the
 *   coin dings already use successfully in-headset) has no element state
 *   machine to wedge: once the context is running, start() plays.
 * - Music: HTMLAudio, because it streams a multi-megabyte file.
 *
 * The context unlocks on a 2D intro button click (a real DOM gesture);
 * everything after that — including UIKit clicks in VR, which are NOT DOM
 * gestures — just works. All paths are relative so the game works from a
 * subpath (GitHub Pages).
 */
const SFX = {
  begin: './audio/begin.ogg',
  one: './audio/countdown-one.ogg',
  two: './audio/countdown-two.ogg',
  three: './audio/countdown-three.ogg',
  die: './audio/die.ogg',
  gameover: './audio/gameover.ogg',
  square: './audio/square.ogg',
  nice: './audio/nice.wav',
  perfect: './audio/perfect.wav',
  welldone: './audio/welldone.wav'
} as const;

export type SfxName = keyof typeof SFX;

export type MusicId =
  | 'clovers'
  | 'new-song-98'
  | 'new-song-129'
  | 'original'
  | 'final'
  | 'chase'
  | 'sakupened'
  | 'fusion'
  | 'give-it-to-me';

/** What plays at the top of the tower: the lobby and the balcony countdown. */
export const LOBBY_TRACK: MusicId = 'clovers';

/** The descent's own songs — one is drawn at random for each ride. */
export const DESCENT_TRACKS: readonly MusicId[] = ['new-song-98', 'new-song-129'];

/** A random descent song — a different one from `except` when there is a choice. */
export function randomDescentTrack(except?: MusicId): MusicId {
  const pool = DESCENT_TRACKS.filter((id) => id !== except);
  const from = pool.length > 0 ? pool : DESCENT_TRACKS;
  return from[Math.floor(Math.random() * from.length)];
}

export interface MusicTrack {
  id: MusicId;
  label: string;
  src: string;
  /** Vorbis stand-in for browsers without AAC (open-codec Chromium builds). */
  fallback?: string;
  /**
   * Playback level. The original, 4 Leaf Clovers, New Song 129 and the
   * M4A-sourced bonus tracks sit around -15 dB mean; Sakupened, Future
   * Vibe, Final and New Song 98 were supplied as hotter masters (~-9 dB
   * mean, peaking at 0), so they play quieter to land at the same loudness
   * in the headset.
   */
  volume: number;
}

export const MUSIC_TRACKS: readonly MusicTrack[] = [
  { id: 'clovers', label: '4 LEAF CLOVERS', src: './audio/four-leaf-clovers.mp3', volume: 0.45 },
  { id: 'new-song-98', label: 'NEW SONG 98', src: './audio/new-song-98.mp3', volume: 0.25 },
  { id: 'new-song-129', label: 'NEW SONG 129', src: './audio/new-song-129.mp3', volume: 0.5 },
  {
    id: 'original',
    label: 'ORIGINAL',
    src: './audio/run.m4a',
    fallback: './audio/run.ogg',
    volume: 0.5
  },
  {
    id: 'final',
    label: 'FINAL',
    src: './audio/final.m4a',
    fallback: './audio/final.ogg',
    volume: 0.32
  },
  { id: 'chase', label: 'CHASE', src: './audio/chase.mp3', volume: 0.5 },
  { id: 'sakupened', label: 'SAKUPENED', src: './audio/sakupened.mp3', volume: 0.32 },
  { id: 'fusion', label: 'FUTURE VIBE', src: './audio/fusion.mp3', volume: 0.32 },
  { id: 'give-it-to-me', label: 'GIVE IT TO ME', src: './audio/give-it-to-me.mp3', volume: 0.5 }
] as const;

export function isMusicId(value: string | null): value is MusicId {
  return MUSIC_TRACKS.some((track) => track.id === value);
}

class AudioManager {
  private ctx: AudioContext | null = null;
  private buffers = new Map<SfxName, AudioBuffer>();
  private live = new Set<AudioBufferSourceNode>();
  private music: HTMLAudioElement | null = null;
  private musicId: MusicId = 'original';
  /** The top-of-the-tower song, on its own player so the descent can take over cleanly. */
  private lobby: HTMLAudioElement | null = null;
  private canPlayAac = false;

  init(): void {
    this.ctx ??= new AudioContext();
    (Object.keys(SFX) as SfxName[]).forEach((name) => {
      void fetch(SFX[name])
        .then((res) => res.arrayBuffer())
        .then((buf) => this.ctx!.decodeAudioData(buf))
        .then((decoded) => this.buffers.set(name, decoded))
        .catch(() => {}); // a missing stinger is never fatal
    });

    // AAC where supported, Vorbis everywhere else (open-codec Chromium
    // builds ship without AAC — no browser should ever lose the music).
    const probe = document.createElement('audio');
    this.canPlayAac = Boolean(probe.canPlayType('audio/mp4; codecs="mp4a.40.2"'));
    // The game picks the (remembered) track right after init — don't start
    // streaming the default only to throw it away.
  }

  /** Replace the streamed soundtrack while preserving the one shared player. */
  selectMusic(id: MusicId): void {
    const track = MUSIC_TRACKS.find((candidate) => candidate.id === id);
    if (!track) return;
    if (this.music && this.musicId === id) return; // already loaded (and maybe playing)
    this.music?.pause();
    this.musicId = id;
    const src = track.fallback && !this.canPlayAac ? track.fallback : track.src;
    this.music = new Audio(src);
    this.music.preload = 'auto';
    this.music.loop = true;
    this.music.volume = track.volume;
  }

  /** The descent track currently loaded. */
  get selectedMusic(): MusicId {
    return this.musicId;
  }

  /** 4 Leaf Clovers at the top: keeps looping until the first drop. No-op if already playing. */
  playLobby(): void {
    if (!this.lobby) {
      const track = MUSIC_TRACKS.find((candidate) => candidate.id === LOBBY_TRACK)!;
      this.lobby = new Audio(track.src);
      this.lobby.preload = 'auto';
      this.lobby.loop = true;
      this.lobby.volume = track.volume;
    }
    if (!this.lobby.paused) return;
    void this.lobby.play().catch(() => {});
  }

  stopLobby(): void {
    this.lobby?.pause();
  }

  get lobbyPlaying(): boolean {
    return Boolean(this.lobby && !this.lobby.paused);
  }

  /** Call from any real DOM gesture (the intro buttons) so the context is
   * running before VR, where UIKit clicks don't count as gestures. */
  unlock(): void {
    void this.ctx?.resume().catch(() => {});
  }

  play(name: SfxName, volume = 1): void {
    const ctx = this.ctx;
    const buffer = this.buffers.get(name);
    if (!ctx || !buffer) return;
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(ctx.destination);
    this.live.add(source);
    source.onended = () => this.live.delete(source);
    source.start();
  }

  /** Tiny synthesized UI blip for menu feedback. */
  blip(freq: number, dur = 0.05, vol = 0.18): void {
    try {
      this.ctx ??= new AudioContext();
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + dur);
    } catch {
      /* feedback audio is never worth crashing over */
    }
  }

  /**
   * Coin ding: a short bright tone that climbs with the streak, Subway
   * Surfers style. Gems get a two-note chime.
   */
  coin(streak: number, gem = false): void {
    try {
      this.ctx ??= new AudioContext();
      const t = this.ctx.currentTime;
      const tone = (freq: number, at: number, dur: number, vol: number): void => {
        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(vol, at + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(gain);
        gain.connect(this.ctx!.destination);
        osc.start(at);
        osc.stop(at + dur + 0.02);
      };
      if (gem) {
        tone(1320, t, 0.12, 0.2);
        tone(1980, t + 0.09, 0.22, 0.2);
        return;
      }
      const step = Math.min(streak, 14);
      tone(880 * Math.pow(2, step / 12), t, 0.11, 0.16);
    } catch {
      /* feedback audio is never worth crashing over */
    }
  }

  startMusic(): void {
    if (!this.music) this.selectMusic(this.musicId);
    if (!this.music) return;
    this.music.currentTime = 0;
    void this.music.play().catch(() => {});
  }

  stopMusic(): void {
    this.music?.pause();
  }

  /** Silence everything: both music players and any playing stinger. */
  stopAll(): void {
    this.lobby?.pause();
    this.stopRun();
  }

  /** Silence the previous run — its song and any stinger — leaving the balcony song alone. */
  stopRun(): void {
    this.music?.pause();
    this.live.forEach((source) => {
      try {
        source.stop();
      } catch {
        /* already ended */
      }
    });
    this.live.clear();
  }
}

export const audio = new AudioManager();
