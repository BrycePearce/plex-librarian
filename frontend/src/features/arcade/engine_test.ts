import { assert, assertEquals, assertGreater, assertNotEquals } from "@std/assert";
import {
  createGameState,
  createStateFromCheckpoint,
  dispatchGameAction,
  stepGame,
} from "./engine.ts";
import { checkpointFromState } from "./persistence.ts";
import type { ArcadeInput, Enemy, GameState, Projectile } from "./types.ts";

const idleInput: ArcadeInput = {
  movement: { x: 0, y: 0 },
  aim: { x: 300, y: 150 },
  firing: false,
  secondary: false,
  reload: false,
  dash: false,
};

function activeState(seed = 7, mode: "normal" | "hard" = "normal") {
  return createGameState(500, 300, { seed, mode, phase: "encounter" });
}

function enemy(overrides: Partial<Enemy> = {}): Enemy {
  return {
    id: 1,
    kind: "file",
    x: 160,
    y: 150,
    radius: 11,
    speed: 0,
    health: 1,
    maxHealth: 1,
    points: 12,
    damage: 1,
    aimAngle: 0,
    behaviorCooldown: 10,
    warningFor: 0,
    phase: 0,
    orbitDirection: 1,
    splitGeneration: 0,
    dashFor: 0,
    dashX: 0,
    dashY: 0,
    elite: false,
    ...overrides,
  };
}

function projectile(overrides: Partial<Projectile> = {}): Projectile {
  return {
    id: 1,
    x: 160,
    y: 150,
    previousX: 150,
    previousY: 150,
    vx: 0,
    vy: 0,
    radius: 3,
    damage: 1,
    pierce: 0,
    life: 1,
    friendly: true,
    hitIds: [],
    bouncesRemaining: 0,
    reflected: false,
    ...overrides,
  };
}

function sequenceRandom(values: number[]) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

Deno.test("arcade runs with the same seed are deterministic", () => {
  const first = activeState(1234);
  const second = activeState(1234);

  for (let frame = 0; frame < 600; frame++) {
    stepGame(first, idleInput, 1 / 60);
    stepGame(second, idleInput, 1 / 60);
  }

  assertEquals(first.rngState, second.rngState);
  assertEquals(first.enemies, second.enemies);
  assertEquals(first.score, second.score);
});

Deno.test("arcade player movement stays inside the arena", () => {
  const state = activeState();
  state.player.x = 490;
  state.spawnCooldown = 10;

  stepGame(state, { ...idleInput, movement: { x: 1, y: 0 } }, 1, () => 0.5);

  assertEquals(state.player.x, 487);
  assertEquals(state.player.y, 150);
});

Deno.test("a new run starts without a shield", () => {
  const state = activeState();

  assertEquals(state.player.shield, 0);
});

Deno.test("fixed timesteps produce stable player movement", () => {
  const sixtyFps = activeState();
  const thirtyFps = activeState();
  sixtyFps.spawnCooldown = 100;
  thirtyFps.spawnCooldown = 100;
  const input = { ...idleInput, movement: { x: 0, y: -1 } };

  for (let frame = 0; frame < 60; frame++) stepGame(sixtyFps, input, 1 / 60);
  for (let frame = 0; frame < 30; frame++) stepGame(thirtyFps, input, 1 / 30);

  assertEquals(Math.round(sixtyFps.player.y), Math.round(thirtyFps.player.y));
});

Deno.test("arcade firing creates weapon projectiles", () => {
  const state = activeState();
  state.spawnCooldown = 10;

  stepGame(state, { ...idleInput, firing: true }, 1 / 60, () => 0.5);

  assertEquals(state.projectiles.length, 1);
  assertGreater(state.projectiles[0].vx, 0);
  assertEquals(state.projectiles[0].friendly, true);
});

Deno.test("dash grants temporary invulnerability and moves quickly", () => {
  const state = activeState();
  state.spawnCooldown = 10;
  const before = state.player.x;

  stepGame(
    state,
    { ...idleInput, movement: { x: 1, y: 0 }, dash: true },
    1 / 60,
    () => 0.5,
  );

  assertGreater(state.player.x - before, 8);
  assertGreater(state.player.invulnerableFor, 0);
  assertGreater(state.player.dashCooldown, 2);
});

Deno.test("swept collision removes an enemy crossed between frames", () => {
  const state = activeState();
  state.spawnCooldown = 10;
  state.enemies = [enemy({ x: 180 })];
  state.projectiles = [
    projectile({ x: 130, previousX: 130, vx: 3600, life: 1 }),
  ];

  stepGame(state, idleInput, 1 / 60, () => 0.5);

  assertEquals(state.enemies.length, 0);
  assertGreater(state.score, 0);
});

Deno.test("hostile projectiles damage the player once", () => {
  const state = activeState();
  state.spawnCooldown = 10;
  state.player.invulnerableFor = 0;
  state.projectiles = [
    projectile({
      x: state.player.x,
      y: state.player.y,
      previousX: state.player.x,
      previousY: state.player.y,
      friendly: false,
    }),
  ];

  stepGame(state, idleInput, 1 / 60, () => 0.5);

  assertEquals(state.player.health, 2);
  assertGreater(state.player.invulnerableFor, 0);
});

Deno.test("finishing an encounter offers three non-maxed upgrades", () => {
  const state = activeState();
  state.spawnCooldown = 10;
  state.objectiveProgress = state.objectiveTarget;

  stepGame(state, idleInput, 1 / 60);

  assertEquals(state.phase, "reward");
  assertEquals(state.offeredUpgrades.length, 3);
  dispatchGameAction(state, {
    type: "chooseUpgrade",
    upgradeId: state.offeredUpgrades[0],
  });
  assertEquals(state.phase, "encounter");
  assertEquals(state.encounterIndex, 1);
});

Deno.test("bosses move through authored phases", () => {
  const state = activeState();
  state.encounterIndex = 2;
  state.objectiveProgress = state.objectiveTarget;
  stepGame(state, idleInput, 1 / 60);
  const chosen = state.offeredUpgrades[0];
  dispatchGameAction(state, { type: "chooseUpgrade", upgradeId: chosen });
  const boss = state.enemies.find((candidate) => candidate.kind === "boss");
  assert(boss);

  boss.health = boss.maxHealth * 0.3;
  stepGame(state, idleInput, 1 / 60, () => 0.5);

  assertEquals(boss.phase, 3);
  assertGreater(state.projectiles.filter((candidate) => !candidate.friendly).length, 0);
});

Deno.test("the duplicate boss summons its 2x adds at a gentler cadence", () => {
  const state = activeState();
  state.actIndex = 1;
  state.phase = "boss";
  state.enemies = [enemy({
    kind: "boss",
    bossKind: "hydra",
    health: 100,
    maxHealth: 100,
    radius: 34,
    behaviorCooldown: 0,
    phase: 1,
  })];

  stepGame(state, idleInput, 1 / 60, () => 0.5);

  assertGreater(state.enemies[0].behaviorCooldown, 1.4);
  assertEquals(state.enemies.filter((candidate) => candidate.kind === "duplicate").length, 1);
});

Deno.test("the duplicate boss caps its late-phase 2x summon burst", () => {
  const state = activeState();
  state.actIndex = 1;
  state.phase = "boss";
  state.enemies = [enemy({
    kind: "boss",
    bossKind: "hydra",
    health: 30,
    maxHealth: 100,
    radius: 34,
    behaviorCooldown: 0,
    phase: 3,
  })];

  stepGame(state, idleInput, 1 / 60, () => 0.5);

  assertGreater(state.enemies[0].behaviorCooldown, 1);
  assertEquals(state.enemies.filter((candidate) => candidate.kind === "duplicate").length, 2);
});

Deno.test("hard mode applies stronger spawn tuning", () => {
  const normal = activeState(9, "normal");
  const hard = activeState(9, "hard");
  normal.enemies = [];
  hard.enemies = [];
  normal.spawnCooldown = 0;
  hard.spawnCooldown = 0;

  stepGame(normal, idleInput, 1 / 60, () => 0.1);
  stepGame(hard, idleInput, 1 / 60, () => 0.1);

  assertEquals(normal.enemies.length, 1);
  assertEquals(hard.enemies.length, 1);
  assertGreater(hard.enemies[0].speed, normal.enemies[0].speed);
  assertGreater(hard.spawnBudgetRemaining, normal.spawnBudgetRemaining);
});

Deno.test("act checkpoints rebuild a clean deterministic arena", () => {
  const state = activeState(42);
  state.actIndex = 1;
  state.score = 3210;
  state.upgrades["rapid-index"] = 2;
  state.player.health = 2;
  const checkpoint = checkpointFromState(state);

  const restored = createStateFromCheckpoint(500, 300, checkpoint);

  assertEquals(restored.actIndex, 1);
  assertEquals(restored.score, 3210);
  assertEquals(restored.upgrades["rapid-index"], 2);
  assertEquals(restored.player.health, 2);
  assertGreater(restored.enemies.length, 0);
  assertEquals(restored.projectiles.length, 0);
  assertEquals(restored.powerupDrops.length, 0);
  assertNotEquals(restored.rngState, 0);
});

Deno.test("a boss defeat advances to an act-complete checkpoint", () => {
  const state = activeState();
  state.phase = "boss";
  state.enemies = [
    enemy({
      kind: "boss",
      bossKind: "backlog",
      health: 0,
      maxHealth: 100,
      radius: 34,
    }),
  ];

  stepGame(state, idleInput, 1 / 60);

  assertEquals(state.phase, "actComplete");
  assertEquals(state.enemies.length, 0);
});

Deno.test("magazines empty and automatically reload", () => {
  const state = activeState();
  state.enemies = [];
  state.spawnCooldown = 100;
  state.player.ammo = 1;

  stepGame(state, { ...idleInput, firing: true }, 1 / 60, () => 0.5);

  assertEquals(state.player.ammo, 0);
  assertGreater(state.player.reloadFor, 0);
  for (let frame = 0; frame < 70; frame++) stepGame(state, idleInput, 1 / 60, () => 0.5);
  assertEquals(state.player.ammo, state.player.magazineSize);
  assertEquals(state.player.reloadFor, 0);
});

Deno.test("Deep Scan pierces regular enemies but has bounded boss damage", () => {
  const state = activeState();
  state.enemies = [
    enemy({ id: 1, x: 330, health: 3, maxHealth: 3 }),
    enemy({
      id: 2,
      kind: "boss",
      bossKind: "backlog",
      x: 400,
      health: 100,
      maxHealth: 100,
      radius: 34,
    }),
  ];
  state.player.x = 250;
  state.player.y = 150;

  stepGame(state, { ...idleInput, aim: { x: 500, y: 150 }, secondary: true }, 1 / 60);

  assertEquals(state.enemies.find((candidate) => candidate.id === 1)?.health, undefined);
  assertEquals(state.enemies.find((candidate) => candidate.id === 2)?.health, 98);
  assertGreater(state.player.secondaryCooldown, 7);
});

Deno.test("relay caches move after collection and expiry costs integrity", () => {
  const state = activeState();
  state.objectiveProgress = state.objectiveTarget;
  stepGame(state, idleInput, 1 / 60);
  dispatchGameAction(state, {
    type: "chooseUpgrade",
    upgradeId: state.offeredUpgrades[0],
  });
  assertEquals(state.encounterIndex, 1);
  assert(state.relayCache);
  state.player.x = state.relayCache.x;
  state.player.y = state.relayCache.y;

  stepGame(state, idleInput, 1 / 60);

  assertEquals(state.objectiveProgress, 1);
  assert(state.relayCache);
  state.player.invulnerableFor = 0;
  state.relayCache.timeRemaining = 0.001;
  const health = state.player.health;
  stepGame(state, idleInput, 1 / 60);
  assertEquals(state.player.health, health - 1);
  assertEquals(state.objectiveProgress, 1);
  assertEquals(state.relayMisses, 1);
});

Deno.test("shooting one physical patch installs only that upgrade", () => {
  const state = activeState();
  state.objectiveProgress = state.objectiveTarget;
  stepGame(state, idleInput, 1 / 60);
  assertEquals(state.upgradeTargets.length, 0);

  const heldFire = { ...idleInput, firing: true };
  for (let index = 0; index < 75; index++) {
    stepGame(state, heldFire, 1 / 60);
  }
  assertEquals(state.upgradeTargets.length, 3);
  assertEquals(Object.keys(state.upgrades).length, 0);

  stepGame(state, idleInput, 1 / 60);
  const target = state.upgradeTargets[0];
  target.entranceFor = 0;
  state.projectiles = [
    projectile({
      x: target.x - 24,
      y: target.y,
      previousX: target.x - 40,
      previousY: target.y,
      vx: 1800,
    }),
  ];

  stepGame(state, idleInput, 1 / 60);

  assertEquals(state.upgrades[target.id], 1);
  assertEquals(state.upgradeTargets.length, 0);
  assertGreater(state.rewardTransitionFor, 0);
});

Deno.test("destroyed red documents telegraph a small damaging burst", () => {
  const state = activeState();
  state.enemies = [enemy({ x: 160, y: 150 })];
  state.spawnCooldown = 100;
  state.player.x = 160;
  state.player.y = 150;
  state.player.invulnerableFor = 0;
  state.projectiles = [projectile()];
  const health = state.player.health;

  stepGame(state, idleInput, 1 / 60, () => 0.5);

  const burst = state.hazards.find((hazard) => hazard.kind === "document-burst");
  assert(burst);
  assertGreater(burst.armFor, 0);
  assertEquals(state.player.health, health);

  for (let index = 0; index < 30; index++) {
    stepGame(state, idleInput, 1 / 60, () => 0.5);
  }
  assertEquals(state.player.health, health - 1);
});

Deno.test("2x enemies primarily split into red explosives", () => {
  const state = activeState();
  state.enemies = [enemy({ kind: "duplicate" })];
  state.projectiles = [projectile()];
  state.spawnCooldown = 100;
  state.dropCooldown = 100;

  stepGame(state, idleInput, 1 / 60, () => 0.2);

  const children = state.enemies.filter((candidate) => candidate.splitGeneration === 1);
  assertEquals(children.map((candidate) => candidate.kind), ["file", "file"]);
});

Deno.test("2x enemies split into two of the same seeded enemy variant", () => {
  const state = activeState();
  state.actIndex = 1;
  state.enemies = [enemy({ kind: "duplicate" })];
  state.projectiles = [projectile()];
  state.spawnCooldown = 100;
  state.dropCooldown = 100;

  stepGame(
    state,
    idleInput,
    1 / 60,
    sequenceRandom([0.7, 0.99, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
  );

  const children = state.enemies.filter((candidate) => candidate.splitGeneration === 1);
  assertEquals(children.map((candidate) => candidate.kind), ["buffering", "buffering"]);
});

Deno.test("2x enemies can drop a powerup or a repair pack", () => {
  const powered = activeState();
  powered.enemies = [enemy({ kind: "duplicate" })];
  powered.projectiles = [projectile()];
  powered.spawnCooldown = 100;
  powered.dropCooldown = 100;
  stepGame(powered, idleInput, 1 / 60, sequenceRandom([0.86, 0, 0.5]));
  assertEquals(powered.powerupDrops.length, 1);
  assertEquals(powered.powerupDrops[0].kind, "machine-gun");
  assertEquals(powered.enemies.filter((candidate) => candidate.splitGeneration === 1).length, 0);

  const wounded = activeState();
  wounded.player.health -= 1;
  wounded.enemies = [enemy({ kind: "duplicate" })];
  wounded.projectiles = [projectile()];
  wounded.spawnCooldown = 100;
  wounded.dropCooldown = 100;
  stepGame(wounded, idleInput, 1 / 60, () => 0.95);
  assertEquals(wounded.powerupDrops.length, 1);
  assertEquals(wounded.powerupDrops[0].kind, "repair");
  assertEquals(wounded.enemies.filter((candidate) => candidate.splitGeneration === 1).length, 0);
});

Deno.test("reflected projectiles bounce from arena walls", () => {
  const state = activeState();
  state.enemies = [];
  state.spawnCooldown = 100;
  state.projectiles = [
    projectile({
      x: 495,
      previousX: 490,
      vx: 600,
      bouncesRemaining: 1,
      reflected: true,
    }),
  ];

  stepGame(state, idleInput, 1 / 60, () => 0.5);

  assert(state.projectiles[0].vx < 0);
  assertEquals(state.projectiles[0].bouncesRemaining, 0);
});

Deno.test("elite drops use the seeded pure RNG roll", () => {
  const state = activeState();
  state.spawnCooldown = 100;
  state.enemies = [enemy({ x: 180, elite: true })];
  state.projectiles = [projectile({ x: 170, previousX: 160, vx: 1200 })];

  stepGame(state, idleInput, 1 / 60, () => 0);

  assertEquals(state.powerupDrops.length, 1);
  assertEquals(state.powerupDrops[0].kind, "machine-gun");
});

Deno.test("machine gun pickup reloads its magazine and preserves the selected weapon ammo", () => {
  const state = activeState();
  state.enemies = [];
  state.spawnCooldown = 100;
  state.powerupDrops = [{
    id: 1,
    kind: "machine-gun",
    x: state.player.x,
    y: state.player.y,
    radius: 13,
    life: 10,
  }];
  stepGame(state, idleInput, 1 / 60, () => 0.5);
  const baseAmmo = state.player.ammo;
  stepGame(state, { ...idleInput, firing: true }, 1 / 60, () => 0.5);

  assertEquals(state.temporaryWeapon, { kind: "machine-gun", ammo: 47 });
  assertEquals(state.player.ammo, baseAmmo);
  assertEquals(state.projectiles[0].damage, 1);

  if (!state.temporaryWeapon) throw new Error("machine gun pickup was not retained");
  state.temporaryWeapon.ammo = 1;
  state.player.fireCooldown = 0;
  stepGame(state, { ...idleInput, firing: true }, 1 / 60, () => 0.5);
  assertEquals(state.temporaryWeapon, { kind: "machine-gun", ammo: 0 });
  assertGreater(state.player.reloadFor, 1);

  state.player.invulnerableFor = 100;
  for (let frame = 0; frame < 30; frame++) stepGame(state, idleInput, 1 / 20, () => 0.5);
  assertEquals(state.temporaryWeapon, { kind: "machine-gun", ammo: 48 });
  assertEquals(state.player.reloadFor, 0);
  assertEquals(state.player.ammo, baseAmmo);
});

Deno.test("super shots reload after six rounds instead of expiring", () => {
  const state = activeState();
  state.enemies = [];
  state.spawnCooldown = 100;
  state.powerupDrops = [{
    id: 1,
    kind: "super-shot",
    x: state.player.x,
    y: state.player.y,
    radius: 13,
    life: 10,
  }];
  stepGame(state, idleInput, 1 / 60, () => 0.5);
  const baseAmmo = state.player.ammo;
  for (let shot = 0; shot < 6; shot++) {
    state.player.fireCooldown = 0;
    stepGame(state, { ...idleInput, firing: true }, 1 / 60, () => 0.5);
  }

  assertEquals(state.temporaryWeapon, { kind: "super-shot", ammo: 0 });
  assertEquals(state.player.ammo, baseAmmo);
  assertGreater(state.projectiles[0].damage, 5);
  assertGreater(state.player.reloadFor, 2);

  state.player.invulnerableFor = 100;
  for (let frame = 0; frame < 46; frame++) stepGame(state, idleInput, 1 / 20, () => 0.5);
  assertEquals(state.temporaryWeapon, { kind: "super-shot", ammo: 6 });
  assertEquals(state.player.reloadFor, 0);
  assertEquals(state.player.ammo, baseAmmo);
});

Deno.test("retained powerups persist until a shielded hit clears the streak", () => {
  const state = activeState();
  state.enemies = [];
  state.spawnCooldown = 100;
  state.projectiles = [
    projectile({
      x: state.player.x + 100,
      y: state.player.y,
      previousX: state.player.x + 100,
      previousY: state.player.y,
      friendly: false,
    }),
  ];
  state.powerupDrops = [{
    id: 1,
    kind: "shield",
    x: state.player.x,
    y: state.player.y,
    radius: 13,
    life: 10,
  }];
  stepGame(state, idleInput, 1 / 60, () => 0.5);
  assertEquals(state.activePowerups.shieldHits, 1);
  assertEquals(state.activePowerups.shieldFor, 1);
  assertEquals(state.projectiles.length, 0);

  state.activePowerups.reflect = 1;
  state.activePowerups.prism = 1;
  state.temporaryWeapon = { kind: "machine-gun", ammo: 12 };
  state.player.invulnerableFor = 100;
  for (let frame = 0; frame < 240; frame++) stepGame(state, idleInput, 1 / 20, () => 0.5);
  assertEquals(state.activePowerups.reflect, 1);
  assertEquals(state.activePowerups.prism, 1);
  assertEquals(state.activePowerups.shieldHits, 1);
  assertEquals(state.temporaryWeapon, { kind: "machine-gun", ammo: 12 });

  const health = state.player.health;
  state.player.invulnerableFor = 0;
  state.projectiles = [projectile({
    x: state.player.x,
    y: state.player.y,
    previousX: state.player.x,
    previousY: state.player.y,
    friendly: false,
  })];
  stepGame(state, idleInput, 1 / 60, () => 0.5);
  assertEquals(state.player.health, health);
  assertEquals(state.activePowerups.reflect, 0);
  assertEquals(state.activePowerups.prism, 0);
  assertEquals(state.activePowerups.shieldFor, 0);
  assertEquals(state.activePowerups.shieldHits, 0);
  assertEquals(state.temporaryWeapon, null);
});

Deno.test("drop director guarantees a pickup after twelve kills and caps each encounter", () => {
  const pity = activeState();
  pity.spawnCooldown = 100;
  for (let kill = 0; kill < 12; kill++) {
    pity.enemies = [enemy({ id: kill + 1, x: 180 })];
    pity.projectiles = [projectile({ id: kill + 1, x: 170, previousX: 160, vx: 1200 })];
    stepGame(pity, idleInput, 1 / 60, () => 0.99);
  }
  assertEquals(pity.powerupDrops.length, 1);
  assertEquals(pity.killsSincePowerupDrop, 0);

  const capped = activeState();
  capped.spawnCooldown = 100;
  for (let kill = 0; kill < 7; kill++) {
    capped.dropCooldown = 0;
    capped.enemies = [enemy({ id: kill + 1, x: 180 })];
    capped.projectiles = [projectile({ id: kill + 1, x: 170, previousX: 160, vx: 1200 })];
    stepGame(capped, idleInput, 1 / 60, () => 0);
  }
  assertEquals(capped.powerupDrops.length, 4);
  assertEquals(capped.powerupsDroppedThisPhase, 4);
  assertNotEquals(capped.powerupDrops[0].kind, capped.powerupDrops[1].kind);
});

Deno.test("repair drops are excluded at full health and heal when eligible", () => {
  const full = activeState();
  full.spawnCooldown = 100;
  full.enemies = [enemy({ x: 180, elite: true })];
  full.projectiles = [projectile({ x: 170, previousX: 160, vx: 1200 })];
  const fullRolls = [0, 0.999];
  stepGame(full, idleInput, 1 / 60, () => fullRolls.shift() ?? 0.999);
  assertNotEquals(full.powerupDrops[0].kind, "repair");

  const wounded = activeState();
  wounded.spawnCooldown = 100;
  wounded.player.health = wounded.player.maxHealth - 1;
  wounded.enemies = [enemy({ x: 180, elite: true })];
  wounded.projectiles = [projectile({ x: 170, previousX: 160, vx: 1200 })];
  const woundedRolls = [0, 0.999];
  stepGame(wounded, idleInput, 1 / 60, () => woundedRolls.shift() ?? 0.999);
  assertEquals(wounded.powerupDrops[0].kind, "repair");
  wounded.powerupDrops[0].x = wounded.player.x;
  wounded.powerupDrops[0].y = wounded.player.y;
  stepGame(wounded, idleInput, 1 / 60, () => 0.5);
  assertEquals(wounded.player.health, wounded.player.maxHealth);
});

Deno.test("pressure director rapidly rebuilds an emptied encounter", () => {
  const state = activeState();
  state.enemies = [];
  state.spawnBudgetRemaining = 0;
  state.spawnCooldown = 0;
  state.player.invulnerableFor = 100;

  for (let frame = 0; frame < 180; frame++) stepGame(state, idleInput, 1 / 60, () => 0.5);

  assertGreater(state.enemies.length, 2);
});

// Keep this type referenced so changes to the public state shape remain visible in tests.
const _gameStateContract: GameState | null = null;
void _gameStateContract;
