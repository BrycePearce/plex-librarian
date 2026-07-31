import { assertEquals } from "@std/assert";
import {
  ARCADE_SAVE_KEY,
  createDefaultSave,
  LEGACY_HIGH_SCORE_KEY,
  readArcadeSave,
  writeArcadeSave,
} from "./persistence.ts";
import type { StorageLike } from "./types.ts";

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

Deno.test("arcade save round trips local progress", () => {
  const storage = new MemoryStorage();
  const save = createDefaultSave();
  save.unlocks.hard = true;
  save.bestScores.normal = 4321;
  save.settings.musicVolume = 19;
  writeArcadeSave(save, storage);

  const restored = readArcadeSave(storage);

  assertEquals(restored.unlocks.hard, true);
  assertEquals(restored.bestScores.normal, 4321);
  assertEquals(restored.settings.musicVolume, 19);
});

Deno.test("arcade save migrates the legacy high score", () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_HIGH_SCORE_KEY, "987");

  const restored = readArcadeSave(storage);

  assertEquals(restored.bestScores.normal, 987);
  assertEquals(JSON.parse(storage.getItem(ARCADE_SAVE_KEY) ?? "").version, 2);
});

Deno.test("arcade save rejects corrupt fields without losing valid progress", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    ARCADE_SAVE_KEY,
    JSON.stringify({
      version: 2,
      settings: { musicVolume: 900, sfxVolume: -4, musicEnabled: "yes" },
      unlocks: { rail: true },
      bestScores: { normal: -12, hard: 50 },
      victories: { normal: 1 },
      achievements: ["One", 2],
      checkpoint: { mode: "impossible", actIndex: 9 },
    }),
  );

  const restored = readArcadeSave(storage);

  assertEquals(restored.settings.musicVolume, 100);
  assertEquals(restored.settings.sfxVolume, 0);
  assertEquals(restored.settings.musicEnabled, true);
  assertEquals(restored.unlocks.rail, true);
  assertEquals(restored.bestScores.normal, 0);
  assertEquals(restored.bestScores.hard, 50);
  assertEquals(restored.achievements, ["One"]);
  assertEquals(restored.checkpoint, null);
});

Deno.test("arcade persistence tolerates blocked storage", () => {
  const blocked: StorageLike = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };

  assertEquals(readArcadeSave(blocked), createDefaultSave());
  writeArcadeSave(createDefaultSave(), blocked);
});
