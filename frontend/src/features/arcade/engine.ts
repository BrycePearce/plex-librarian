export interface Point {
  x: number;
  y: number;
}

export interface ArcadeInput {
  movement: Point;
  aim: Point;
  firing: boolean;
}

export interface Player extends Point {
  health: number;
  angle: number;
  invulnerableFor: number;
  fireCooldown: number;
}

export type EnemyKind = "file" | "media" | "library" | "malicious";

export interface Enemy extends Point {
  id: number;
  kind: EnemyKind;
  radius: number;
  speed: number;
  health: number;
  maxHealth: number;
  points: number;
  aimAngle?: number;
  spinPhase?: number;
  shootCooldown?: number;
  orbitDirection?: number;
}

export interface Projectile extends Point {
  id: number;
  vx: number;
  vy: number;
  life: number;
}

export interface EnemyProjectile extends Point {
  id: number;
  vx: number;
  vy: number;
  life: number;
}

export interface ArcadeState {
  width: number;
  height: number;
  player: Player;
  enemies: Enemy[];
  projectiles: Projectile[];
  enemyProjectiles: EnemyProjectile[];
  score: number;
  comboCount: number;
  comboMultiplier: number;
  comboTimer: number;
  wave: number;
  elapsed: number;
  nextEnemyId: number;
  nextProjectileId: number;
  nextEnemyProjectileId: number;
  spawnCooldown: number;
  gameOver: boolean;
}

const PLAYER_SPEED = 260;
const PLAYER_RADIUS = 13;
const PROJECTILE_SPEED = 620;
const PROJECTILE_RADIUS = 3;
const FIRE_INTERVAL = 0.13;
const COMBO_WINDOW = 2.4;

export function createArcadeState(width: number, height: number): ArcadeState {
  return {
    width,
    height,
    player: {
      x: width / 2,
      y: height / 2,
      health: 3,
      angle: 0,
      invulnerableFor: 0,
      fireCooldown: 0,
    },
    enemies: [],
    projectiles: [],
    enemyProjectiles: [],
    score: 0,
    comboCount: 0,
    comboMultiplier: 1,
    comboTimer: 0,
    wave: 1,
    elapsed: 0,
    nextEnemyId: 1,
    nextProjectileId: 1,
    nextEnemyProjectileId: 1,
    spawnCooldown: 0.7,
    gameOver: false,
  };
}

export function resizeArcadeState(state: ArcadeState, width: number, height: number) {
  state.width = width;
  state.height = height;
  state.player.x = clamp(state.player.x, PLAYER_RADIUS, width - PLAYER_RADIUS);
  state.player.y = clamp(state.player.y, PLAYER_RADIUS, height - PLAYER_RADIUS);
}

export function stepArcade(
  state: ArcadeState,
  input: ArcadeInput,
  delta: number,
  random = Math.random,
) {
  if (state.gameOver) return;

  const dt = Math.min(delta, 0.05);
  state.elapsed += dt;
  state.wave = 1 + Math.floor(state.elapsed / 20);
  state.player.invulnerableFor = Math.max(0, state.player.invulnerableFor - dt);
  state.player.fireCooldown = Math.max(0, state.player.fireCooldown - dt);
  state.comboTimer = Math.max(0, state.comboTimer - dt);
  if (state.comboTimer === 0) {
    state.comboCount = 0;
    state.comboMultiplier = 1;
  }

  const moveLength = Math.hypot(input.movement.x, input.movement.y) || 1;
  state.player.x = clamp(
    state.player.x + (input.movement.x / moveLength) * PLAYER_SPEED * dt,
    PLAYER_RADIUS,
    state.width - PLAYER_RADIUS,
  );
  state.player.y = clamp(
    state.player.y + (input.movement.y / moveLength) * PLAYER_SPEED * dt,
    PLAYER_RADIUS,
    state.height - PLAYER_RADIUS,
  );

  const aimX = input.aim.x - state.player.x;
  const aimY = input.aim.y - state.player.y;
  const aimLength = Math.hypot(aimX, aimY);
  if (aimLength > 0.001) state.player.angle = Math.atan2(aimY, aimX);

  if (input.firing && state.player.fireCooldown === 0 && aimLength > 0.001) {
    state.projectiles.push({
      id: state.nextProjectileId++,
      x: state.player.x + Math.cos(state.player.angle) * 20,
      y: state.player.y + Math.sin(state.player.angle) * 20,
      vx: Math.cos(state.player.angle) * PROJECTILE_SPEED,
      vy: Math.sin(state.player.angle) * PROJECTILE_SPEED,
      life: 1.2,
    });
    state.player.fireCooldown = FIRE_INTERVAL;
  }

  state.spawnCooldown -= dt;
  if (state.spawnCooldown <= 0) {
    state.enemies.push(spawnEnemy(state, random));
    state.spawnCooldown = Math.max(0.28, 1.05 - state.wave * 0.08) * (0.7 + random() * 0.6);
  }

  for (const projectile of state.projectiles) {
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;
    projectile.life -= dt;
  }

  for (const projectile of state.enemyProjectiles) {
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;
    projectile.life -= dt;
  }

  for (const enemy of state.enemies) {
    if (enemy.kind === "malicious") {
      updateMaliciousEnemy(state, enemy, dt, random);
      continue;
    }
    const dx = state.player.x - enemy.x;
    const dy = state.player.y - enemy.y;
    const length = Math.hypot(dx, dy) || 1;
    enemy.x += (dx / length) * enemy.speed * dt;
    enemy.y += (dy / length) * enemy.speed * dt;
  }

  const destroyed = new Set<number>();
  const spent = new Set<number>();
  for (const projectile of state.projectiles) {
    for (const enemy of state.enemies) {
      if (destroyed.has(enemy.id) || spent.has(projectile.id)) continue;
      if (
        Math.hypot(projectile.x - enemy.x, projectile.y - enemy.y) <=
          enemy.radius + PROJECTILE_RADIUS
      ) {
        spent.add(projectile.id);
        enemy.health -= 1;
        if (enemy.health <= 0) {
          destroyed.add(enemy.id);
          state.comboCount = state.comboTimer > 0 ? state.comboCount + 1 : 1;
          state.comboMultiplier = Math.min(5, 1 + Math.floor(state.comboCount / 3));
          state.comboTimer = COMBO_WINDOW;
          state.score += enemy.points * state.comboMultiplier;
        }
      }
    }
  }

  const spentEnemyProjectiles = new Set<number>();
  if (state.player.invulnerableFor === 0) {
    const collision = state.enemyProjectiles.find((projectile) =>
      Math.hypot(state.player.x - projectile.x, state.player.y - projectile.y) <=
        PLAYER_RADIUS + 4
    );
    if (collision) {
      spentEnemyProjectiles.add(collision.id);
      damagePlayer(state);
    }
  }

  if (state.player.invulnerableFor === 0) {
    const collision = state.enemies.find((enemy) =>
      !destroyed.has(enemy.id) &&
      Math.hypot(state.player.x - enemy.x, state.player.y - enemy.y) <=
        PLAYER_RADIUS + enemy.radius
    );
    if (collision) {
      destroyed.add(collision.id);
      damagePlayer(state);
    }
  }

  state.projectiles = state.projectiles.filter((projectile) =>
    !spent.has(projectile.id) && projectile.life > 0 && projectile.x >= -20 &&
    projectile.x <= state.width + 20 && projectile.y >= -20 &&
    projectile.y <= state.height + 20
  );
  state.enemyProjectiles = state.enemyProjectiles.filter((projectile) =>
    !spentEnemyProjectiles.has(projectile.id) && projectile.life > 0 &&
    projectile.x >= -30 && projectile.x <= state.width + 30 &&
    projectile.y >= -30 && projectile.y <= state.height + 30
  );
  state.enemies = state.enemies.filter((enemy) => !destroyed.has(enemy.id));
}

function spawnEnemy(state: ArcadeState, random: () => number): Enemy {
  const edge = Math.floor(random() * 4);
  let x = random() * state.width;
  let y = random() * state.height;
  const kind = chooseEnemyKind(state, random());
  const stats = enemyStats(kind);

  if (edge === 0) y = -stats.radius;
  if (edge === 1) x = state.width + stats.radius;
  if (edge === 2) y = state.height + stats.radius;
  if (edge === 3) x = -stats.radius;

  const enemy: Enemy = {
    id: state.nextEnemyId++,
    kind,
    x,
    y,
    radius: stats.radius,
    speed: stats.speed + state.wave * 5 + random() * 24,
    health: stats.health,
    maxHealth: stats.health,
    points: stats.points,
  };
  if (kind === "malicious") {
    enemy.aimAngle = 0;
    enemy.spinPhase = random() * Math.PI * 2;
    enemy.shootCooldown = 0.9 + random() * 0.5;
    enemy.orbitDirection = random() > 0.5 ? 1 : -1;
  }
  return enemy;
}

function chooseEnemyKind(state: ArcadeState, roll: number): EnemyKind {
  const { wave } = state;
  const maliciousCount = state.enemies.filter((enemy) => enemy.kind === "malicious").length;
  if (wave >= 3 && maliciousCount < 2 && roll > 0.92) return "malicious";
  const libraryThreshold = wave >= 3 ? 0.84 : wave >= 2 ? 0.9 : 0.96;
  const mediaThreshold = wave >= 2 ? 0.52 : 0.68;
  if (roll > libraryThreshold) return "library";
  if (roll > mediaThreshold) return "media";
  return "file";
}

function enemyStats(kind: EnemyKind) {
  if (kind === "malicious") return { radius: 13, speed: 58, health: 3, points: 50 };
  if (kind === "library") return { radius: 20, speed: 43, health: 4, points: 70 };
  if (kind === "media") return { radius: 15, speed: 61, health: 2, points: 25 };
  return { radius: 11, speed: 78, health: 1, points: 10 };
}

function updateMaliciousEnemy(
  state: ArcadeState,
  enemy: Enemy,
  dt: number,
  random: () => number,
) {
  const dx = state.player.x - enemy.x;
  const dy = state.player.y - enemy.y;
  const distance = Math.hypot(dx, dy) || 1;
  const towardX = dx / distance;
  const towardY = dy / distance;
  const orbit = enemy.orbitDirection ?? 1;
  const radialDirection = distance > 275 ? 1 : distance < 190 ? -1 : 0;
  const orbitWeight = radialDirection === 0 ? 1 : 0.35;

  enemy.x += (towardX * radialDirection - towardY * orbit * orbitWeight) * enemy.speed * dt;
  enemy.y += (towardY * radialDirection + towardX * orbit * orbitWeight) * enemy.speed * dt;
  enemy.x = clamp(enemy.x, enemy.radius, state.width - enemy.radius);
  enemy.y = clamp(enemy.y, enemy.radius, state.height - enemy.radius);
  enemy.aimAngle = Math.atan2(dy, dx);
  enemy.spinPhase = (enemy.spinPhase ?? 0) + dt * 3.2 * orbit;
  enemy.shootCooldown = (enemy.shootCooldown ?? 1) - dt;

  if (enemy.shootCooldown > 0 || distance > 520) return;

  const shotAngle = enemy.aimAngle + Math.sin(enemy.spinPhase) * 0.22;
  const speed = 215;
  state.enemyProjectiles.push({
    id: state.nextEnemyProjectileId++,
    x: enemy.x + Math.cos(shotAngle) * 18,
    y: enemy.y + Math.sin(shotAngle) * 18,
    vx: Math.cos(shotAngle) * speed,
    vy: Math.sin(shotAngle) * speed,
    life: 3.2,
  });
  enemy.shootCooldown = Math.max(1.25, 2.1 - state.wave * 0.06) + random() * 0.35;
}

function damagePlayer(state: ArcadeState) {
  state.player.health -= 1;
  state.player.invulnerableFor = 1.1;
  if (state.player.health <= 0) state.gameOver = true;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
