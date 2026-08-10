import { assertEquals, assertNotEquals } from "@std/assert";
import { ArcadeAudio, type MusicTrackUrls, resolveMusicCue } from "./audio.ts";
import { createDefaultSave } from "./persistence.ts";
import { ARCADE_MUSIC_GAIN } from "../../lib/arcadeLaunch.ts";

const TRACKS: MusicTrackUrls = {
  stale: "/stale.mp3",
  "backfill-miniboss": "/backfill-miniboss.ogg",
  "backlog-boss": "/backlog-boss.mp3",
  duplicate: "/duplicate.mp3",
  "duplicate-boss": "/duplicate-boss.ogg",
  rogue: "/rogue.mp3",
  "rogue-boss": "/rogue-boss.mp3",
};

function fakeAudio() {
  let plays = 0;
  let pauses = 0;
  const element = {
    src: "",
    volume: 0,
    muted: false,
    currentTime: 0,
    loop: false,
    preload: "",
    play() {
      plays += 1;
      return Promise.resolve();
    },
    pause() {
      pauses += 1;
    },
  } as unknown as HTMLAudioElement;
  return { element, plays: () => plays, pauses: () => pauses };
}

Deno.test("music cues map every act, boss, and endless round", () => {
  assertEquals(resolveMusicCue(0, "encounter"), "stale");
  assertEquals(resolveMusicCue(0, "reward"), "stale");
  assertEquals(resolveMusicCue(0, "boss"), "backlog-boss");
  assertEquals(resolveMusicCue(0, "miniboss"), "backfill-miniboss");
  assertEquals(resolveMusicCue(1, "encounter"), "duplicate");
  assertEquals(resolveMusicCue(1, "boss"), "duplicate-boss");
  assertEquals(resolveMusicCue(2, "encounter"), "rogue");
  assertEquals(resolveMusicCue(2, "boss"), "rogue-boss");
  for (let round = 1; round <= 8; round++) {
    assertNotEquals(
      resolveMusicCue(2, "endless", round),
      resolveMusicCue(2, "endless", round + 1),
    );
  }
});

Deno.test(
  "audio starts with the original track and crossfades to the Act 1 boss",
  async () => {
    const first = fakeAudio();
    const second = fakeAudio();
    const audio = new ArcadeAudio(
      [first.element, second.element],
      TRACKS,
      createDefaultSave().settings,
    );

    audio.startFor(0, "encounter");
    await Promise.resolve();
    assertEquals(first.element.src, "/stale.mp3");
    assertEquals(first.plays(), 1);
    assertEquals(
      first.element.volume,
      (createDefaultSave().settings.musicVolume / 100) * ARCADE_MUSIC_GAIN,
    );

    audio.startFor(0, "boss");
    await Promise.resolve();
    assertEquals(second.element.src, "/backlog-boss.mp3");
    assertEquals(second.plays(), 1);
    assertEquals(second.element.volume, 0);

    audio.destroy();
    assertEquals(first.element.currentTime, 0);
    assertEquals(second.element.currentTime, 0);
  },
);

Deno.test(
  "a resumed later act still opens with the original main-branch song",
  async () => {
    const first = fakeAudio();
    const second = fakeAudio();
    const audio = new ArcadeAudio(
      [first.element, second.element],
      TRACKS,
      createDefaultSave().settings,
    );

    audio.startOpeningFor(1, "encounter");
    await Promise.resolve();
    assertEquals(first.element.src, "/stale.mp3");

    audio.startFor(1, "reward");
    await Promise.resolve();
    assertEquals(second.element.src, "/duplicate.mp3");
    audio.destroy();
  },
);

Deno.test(
  "an opening track started by navigation is adopted without restarting",
  () => {
    const first = fakeAudio();
    const second = fakeAudio();
    first.element.src = "/stale.mp3";
    first.element.currentTime = 8;
    const audio = new ArcadeAudio(
      [first.element, second.element],
      TRACKS,
      createDefaultSave().settings,
      "stale",
    );

    audio.startOpeningFor(0, "encounter");

    assertEquals(first.element.src, "/stale.mp3");
    assertEquals(first.element.currentTime, 8);
    audio.destroy();
  },
);

Deno.test("music settings apply to both crossfade elements", () => {
  const first = fakeAudio();
  const second = fakeAudio();
  const settings = createDefaultSave().settings;
  const audio = new ArcadeAudio(
    [first.element, second.element],
    TRACKS,
    settings,
  );
  audio.startFor(1, "encounter");
  audio.applySettings({ ...settings, musicEnabled: false, musicVolume: 63 });

  assertEquals(first.element.muted, true);
  assertEquals(second.element.muted, true);
  assertEquals(first.element.volume, 0);
  assertEquals(second.element.volume, 0);
  audio.destroy();
});
