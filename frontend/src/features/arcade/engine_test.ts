import { assertEquals, assertGreater } from "@std/assert";
import { createArcadeState, stepArcade } from "./engine.ts";

const idleInput = {
  movement: { x: 0, y: 0 },
  aim: { x: 200, y: 100 },
  firing: false,
};

Deno.test("arcade player movement stays inside the arena", () => {
  const state = createArcadeState(200, 100);
  state.player.x = 190;
  state.player.y = 50;

  stepArcade(state, { ...idleInput, movement: { x: 1, y: 0 } }, 1, () => 0.5);

  assertEquals(state.player.x, 187);
  assertEquals(state.player.y, 50);
});

Deno.test("arcade firing creates an outward-moving projectile", () => {
  const state = createArcadeState(200, 100);
  state.spawnCooldown = 10;

  stepArcade(state, { ...idleInput, firing: true }, 0.01, () => 0.5);

  assertEquals(state.projectiles.length, 1);
  assertGreater(state.projectiles[0].vx, 0);
});

Deno.test("arcade collision removes an enemy and awards points", () => {
  const state = createArcadeState(200, 100);
  state.spawnCooldown = 10;
  state.enemies.push({
    id: 1,
    kind: "file",
    x: 130,
    y: 50,
    radius: 11,
    speed: 0,
    health: 1,
    maxHealth: 1,
    points: 10,
  });
  state.projectiles.push({ id: 1, x: 125, y: 50, vx: 0, vy: 0, life: 1 });

  stepArcade(state, idleInput, 0.01, () => 0.5);

  assertEquals(state.enemies.length, 0);
  assertEquals(state.projectiles.length, 0);
  assertEquals(state.score, 10);
});

Deno.test("arcade quick kills build a score multiplier", () => {
  const state = createArcadeState(300, 150);
  state.spawnCooldown = 10;

  for (let index = 0; index < 3; index++) {
    state.enemies.push({
      id: index + 1,
      kind: "file",
      x: 150,
      y: 50,
      radius: 11,
      speed: 0,
      health: 1,
      maxHealth: 1,
      points: 10,
    });
    state.projectiles.push({
      id: index + 1,
      x: 150,
      y: 50,
      vx: 0,
      vy: 0,
      life: 1,
    });
    stepArcade(state, idleInput, 0.01, () => 0.5);
  }

  assertEquals(state.comboCount, 3);
  assertEquals(state.comboMultiplier, 2);
  assertEquals(state.score, 40);
});

Deno.test("malicious user projectiles damage the player", () => {
  const state = createArcadeState(300, 150);
  state.spawnCooldown = 10;
  state.enemyProjectiles.push({
    id: 1,
    x: state.player.x,
    y: state.player.y,
    vx: 0,
    vy: 0,
    life: 1,
  });

  stepArcade(state, idleInput, 0.01, () => 0.5);

  assertEquals(state.player.health, 2);
  assertEquals(state.enemyProjectiles.length, 0);
});

Deno.test("malicious users fire oscillating projectiles", () => {
  const state = createArcadeState(500, 300);
  state.spawnCooldown = 10;
  state.enemies.push({
    id: 1,
    kind: "malicious",
    x: 100,
    y: 150,
    radius: 13,
    speed: 0,
    health: 3,
    maxHealth: 3,
    points: 50,
    aimAngle: 0,
    spinPhase: Math.PI / 2,
    shootCooldown: 0,
    orbitDirection: 1,
  });

  stepArcade(state, idleInput, 0.01, () => 0.5);

  assertEquals(state.enemyProjectiles.length, 1);
  assertGreater(state.enemyProjectiles[0].vy, 0);
});
