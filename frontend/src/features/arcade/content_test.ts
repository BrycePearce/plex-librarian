import { assertEquals, assertGreaterOrEqual } from "@std/assert";
import { ACTS, DIFFICULTIES, UPGRADES, WEAPONS } from "./content.ts";

Deno.test("arcade ships three complete authored acts", () => {
  assertEquals(ACTS.length, 3);
  assertEquals(ACTS.map((act) => act.encounters.length), [3, 3, 3]);
  assertEquals(new Set(ACTS.map((act) => act.boss.kind)).size, 3);
  assertEquals(
    ACTS.flatMap((act) => act.encounters).map((encounter) => encounter.objective),
    ["purge", "relay", "survive", "purge", "relay", "survive", "purge", "relay", "survive"],
  );
});

Deno.test("arcade content exposes the promised build depth", () => {
  assertEquals(WEAPONS.length, 3);
  assertEquals(UPGRADES.length, 18);
  assertEquals(Object.keys(DIFFICULTIES), ["normal", "hard"]);
  for (const upgrade of UPGRADES) assertGreaterOrEqual(upgrade.maxLevel, 1);
});

Deno.test("the Duplicate Hydra uses its nerfed health budget", () => {
  assertEquals(ACTS[1].boss.health, 258);
});
