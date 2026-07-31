import type { ArcadeSettings, GamePhase } from "./types.ts";

export type ArcadeSfx =
  | "fire"
  | "hit"
  | "damage"
  | "dash"
  | "warning"
  | "reward"
  | "boss"
  | "select"
  | "beam"
  | "powerup"
  | "reload";

export type MusicCue =
  | "stale"
  | "backlog-boss"
  | "duplicate"
  | "duplicate-boss"
  | "rogue"
  | "rogue-boss";

export type MusicTrackUrls = Record<MusicCue, string>;

const ENDLESS_CUES: MusicCue[] = [
  "backlog-boss",
  "duplicate",
  "duplicate-boss",
  "rogue",
  "rogue-boss",
];
const CROSSFADE_MS = 700;
const CROSSFADE_TICK_MS = 50;

export function resolveMusicCue(
  actIndex: number,
  phase: GamePhase,
  endlessRound = 0,
): MusicCue {
  if (phase === "endless") {
    return ENDLESS_CUES[Math.max(0, endlessRound - 1) % ENDLESS_CUES.length];
  }
  if (phase === "boss") {
    return actIndex === 0 ? "backlog-boss" : actIndex === 1 ? "duplicate-boss" : "rogue-boss";
  }
  return actIndex === 0 ? "stale" : actIndex === 1 ? "duplicate" : "rogue";
}

export class ArcadeAudio {
  private readonly musicElements: [HTMLAudioElement, HTMLAudioElement];
  private readonly trackUrls: MusicTrackUrls;
  private settings: ArcadeSettings;
  private context: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private fadeTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private activeElementIndex = 0;
  private outgoingElementIndex: number | null = null;
  private fadeProgress = 1;
  private cue: MusicCue | null = null;
  private openingStateKey: string | null = null;
  private paused = false;

  constructor(
    musicElements: [HTMLAudioElement, HTMLAudioElement],
    trackUrls: MusicTrackUrls,
    settings: ArcadeSettings,
    initialCue: MusicCue | null = null,
  ) {
    this.musicElements = musicElements;
    this.trackUrls = trackUrls;
    this.settings = settings;
    this.cue = initialCue;
    for (const element of musicElements) {
      element.loop = true;
      element.preload = "none";
    }
    this.applySettings(settings);
  }

  applySettings(settings: ArcadeSettings) {
    this.settings = settings;
    for (const element of this.musicElements) element.muted = !settings.musicEnabled;
    this.updateMusicVolumes();
    if (this.sfxGain) {
      this.sfxGain.gain.value = settings.sfxEnabled ? settings.sfxVolume / 100 * 0.28 : 0;
    }
    if (!settings.musicEnabled) {
      for (const element of this.musicElements) element.pause();
    } else if (!this.paused && this.cue) {
      this.playActiveMusic();
    }
  }

  startFor(actIndex: number, phase: GamePhase, endlessRound = 0) {
    const stateKey = `${actIndex}:${phase}:${endlessRound}`;
    if (this.cue === null) this.openingStateKey = stateKey;
    if (this.openingStateKey !== null && this.openingStateKey !== stateKey) {
      this.openingStateKey = null;
    }
    const nextCue = this.openingStateKey === stateKey
      ? "stale"
      : resolveMusicCue(actIndex, phase, endlessRound);
    this.ensureContext();
    this.paused = false;
    if (this.cue === nextCue) {
      this.resume();
      return;
    }

    const nextUrl = this.trackUrls[nextCue];
    if (this.cue === null) {
      const element = this.musicElements[this.activeElementIndex];
      element.src = nextUrl;
      element.currentTime = 0;
      this.cue = nextCue;
      this.fadeProgress = 1;
      this.updateMusicVolumes();
      if (this.settings.musicEnabled) void element.play().catch(() => undefined);
      return;
    }

    if (this.outgoingElementIndex !== null) this.finishFade();
    else this.stopFade(true);
    const outgoingIndex = this.activeElementIndex;
    const incomingIndex = outgoingIndex === 0 ? 1 : 0;
    const incoming = this.musicElements[incomingIndex];
    incoming.pause();
    incoming.src = nextUrl;
    incoming.currentTime = 0;
    incoming.loop = true;
    this.outgoingElementIndex = outgoingIndex;
    this.activeElementIndex = incomingIndex;
    this.fadeProgress = 0;
    this.cue = nextCue;
    this.updateMusicVolumes();

    if (!this.settings.musicEnabled) {
      this.finishFade();
      return;
    }
    void incoming.play().catch(() => undefined);
    const steps = CROSSFADE_MS / CROSSFADE_TICK_MS;
    this.fadeTimer = globalThis.setInterval(() => {
      if (this.paused || !this.settings.musicEnabled) return;
      this.fadeProgress = Math.min(1, this.fadeProgress + 1 / steps);
      this.updateMusicVolumes();
      if (this.fadeProgress >= 1) this.finishFade();
    }, CROSSFADE_TICK_MS);
  }

  startOpeningFor(actIndex: number, phase: GamePhase, endlessRound = 0) {
    this.openingStateKey = `${actIndex}:${phase}:${endlessRound}`;
    this.startFor(actIndex, phase, endlessRound);
  }

  pause() {
    this.paused = true;
    for (const element of this.musicElements) element.pause();
    if (this.context?.state === "running") void this.context.suspend();
  }

  resume() {
    if (!this.cue) return;
    this.paused = false;
    if (this.context?.state === "suspended") void this.context.resume();
    if (this.settings.musicEnabled) this.playActiveMusic();
  }

  playSfx(kind: ArcadeSfx) {
    if (!this.settings.sfxEnabled) return;
    const context = this.ensureContext();
    const gain = this.sfxGain;
    if (!context || !gain) return;
    const now = context.currentTime;
    const notes: Record<ArcadeSfx, [number, number, OscillatorType, number]> = {
      fire: [420, 0.045, "square", 0.035],
      hit: [180, 0.07, "triangle", 0.07],
      damage: [92, 0.22, "sawtooth", 0.15],
      dash: [260, 0.12, "sine", 0.09],
      warning: [330, 0.18, "square", 0.055],
      reward: [660, 0.24, "triangle", 0.12],
      boss: [74, 0.55, "sawtooth", 0.18],
      select: [520, 0.09, "sine", 0.08],
      beam: [980, 0.18, "sawtooth", 0.1],
      powerup: [740, 0.28, "triangle", 0.12],
      reload: [240, 0.12, "square", 0.05],
    };
    const [frequency, duration, wave, volume] = notes[kind];
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(frequency, now);
    if (kind === "dash") oscillator.frequency.exponentialRampToValueAtTime(620, now + duration);
    if (kind === "damage") oscillator.frequency.exponentialRampToValueAtTime(48, now + duration);
    envelope.gain.setValueAtTime(volume, now);
    envelope.gain.exponentialRampToValueAtTime(0.001, now + duration);
    oscillator.connect(envelope);
    envelope.connect(gain);
    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  destroy() {
    this.stopFade(false);
    this.cue = null;
    this.openingStateKey = null;
    for (const element of this.musicElements) {
      element.pause();
      element.currentTime = 0;
      element.volume = 0;
    }
    if (this.context) void this.context.close();
    this.context = null;
    this.sfxGain = null;
  }

  private ensureContext() {
    if (this.context) return this.context;
    const AudioContextClass = globalThis.AudioContext ??
      (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextClass) return null;
    this.context = new AudioContextClass();
    this.sfxGain = this.context.createGain();
    this.sfxGain.connect(this.context.destination);
    this.applySettings(this.settings);
    return this.context;
  }

  private playActiveMusic() {
    const active = this.musicElements[this.activeElementIndex];
    void active.play().catch(() => undefined);
    if (this.outgoingElementIndex !== null && this.fadeProgress < 1) {
      void this.musicElements[this.outgoingElementIndex].play().catch(() => undefined);
    }
  }

  private updateMusicVolumes() {
    const volume = this.settings.musicEnabled ? this.settings.musicVolume / 100 : 0;
    this.musicElements[this.activeElementIndex].volume = volume * this.fadeProgress;
    if (this.outgoingElementIndex !== null) {
      this.musicElements[this.outgoingElementIndex].volume = volume * (1 - this.fadeProgress);
    } else {
      this.musicElements[this.activeElementIndex === 0 ? 1 : 0].volume = 0;
    }
  }

  private finishFade() {
    const outgoingIndex = this.outgoingElementIndex;
    this.stopFade(false);
    this.fadeProgress = 1;
    if (outgoingIndex !== null) {
      const outgoing = this.musicElements[outgoingIndex];
      outgoing.pause();
      outgoing.currentTime = 0;
      outgoing.volume = 0;
    }
    this.outgoingElementIndex = null;
    this.updateMusicVolumes();
  }

  private stopFade(keepOutgoingPlaying: boolean) {
    if (this.fadeTimer !== null) {
      globalThis.clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
    if (!keepOutgoingPlaying && this.outgoingElementIndex !== null) {
      this.musicElements[this.outgoingElementIndex].pause();
    }
  }
}
