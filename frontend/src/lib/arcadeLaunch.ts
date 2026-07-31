/// <reference lib="dom" />

export const ARCADE_SAVE_KEY = "plex-librarian:arcade-save-v2";
export const ARCADE_OPENING_TRACK_URL = "/arcade/oldschool-action-theme.mp3";
export const ARCADE_MUSIC_GAIN = 2 / 3;

const DEFAULT_MUSIC_VOLUME = 28;
let primedLaunchMusic: HTMLAudioElement | null = null;

export function readArcadeLaunchMusicSettings() {
  try {
    const raw = globalThis.localStorage.getItem(ARCADE_SAVE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const settings = parsed && typeof parsed === "object" ? parsed.settings : null;
    return {
      enabled: typeof settings?.musicEnabled === "boolean" ? settings.musicEnabled : true,
      volume: typeof settings?.musicVolume === "number"
        ? Math.max(0, Math.min(100, settings.musicVolume))
        : DEFAULT_MUSIC_VOLUME,
    };
  } catch {
    return { enabled: true, volume: DEFAULT_MUSIC_VOLUME };
  }
}

export function primeArcadeLaunchMusic(url: string, volume: number) {
  if (typeof Audio === "undefined") return null;
  cancelArcadeLaunchMusic();
  const element = new Audio(url);
  element.loop = true;
  element.preload = "auto";
  element.volume = Math.max(0, Math.min(1, volume)) * ARCADE_MUSIC_GAIN;
  primedLaunchMusic = element;
  void element.play().catch(() => undefined);
  return element;
}

export function claimArcadeLaunchMusic() {
  const element = primedLaunchMusic;
  primedLaunchMusic = null;
  return element;
}

export function cancelArcadeLaunchMusic(element?: HTMLAudioElement | null) {
  if (!primedLaunchMusic || (element && primedLaunchMusic !== element)) return;
  primedLaunchMusic.pause();
  primedLaunchMusic.currentTime = 0;
  primedLaunchMusic = null;
}
