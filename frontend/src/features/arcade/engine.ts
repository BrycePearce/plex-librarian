import { ACTS, DIFFICULTIES, UPGRADE_BY_ID, UPGRADES } from "./content.ts";
import type {
  ArcadeCheckpoint,
  ArcadeInput,
  DifficultyMode,
  EncounterDefinition,
  Enemy,
  EnemyKind,
  GameAction,
  GameState,
  Hazard,
  Point,
  Projectile,
  TemporaryPowerupKind,
  TemporaryWeaponKind,
  UpgradeId,
  WeaponKind,
} from "./types.ts";

const PLAYER_RADIUS = 13;
const BASE_PLAYER_SPEED = 255;
const BASE_PROJECTILE_SPEED = 610;
const BASE_FIRE_INTERVAL = 0.14;
const BASE_DASH_COOLDOWN = 2.35;
const BASE_DASH_DURATION = 0.2;
const DASH_SPEED = 760;
const MAX_ENEMIES = 140;
const MAX_PROJECTILES = 260;
const MAX_HAZARDS = 80;
const MAX_PARTICLES = 280;
const RELAY_RADIUS = 18;
const UPGRADE_TARGET_RADIUS = 28;
const BASE_SECONDARY_COOLDOWN = 7.5;
const DEEP_SCAN_BASE_WIDTH = 10;
const DEEP_SCAN_BACKLOG_KNOCKBACK = 48;
const REFLECT_LIFE_MULTIPLIER = 3.5;
const REFLECT_BOUNCES = 8;
const REWARD_REVEAL_DELAY = 1;
const DOCUMENT_BURST_RADIUS = 46;
const DOCUMENT_BURST_WARNING = 0.45;
const NORMAL_DROP_CHANCE = 0.015;
const ELITE_DROP_CHANCE = 0.35;
const DROP_PITY_KILLS = 12;
const DROP_COOLDOWN = 6;
const MACHINE_GUN_AMMO = 48;
const SUPER_SHOT_AMMO = 8;
const MACHINE_GUN_RELOAD = 1.35;
const SUPER_SHOT_RELOAD = 1.7;
const FREEZE_DURATION = 4;
const FROZEN_DAMAGE_MULTIPLIER = 1.75;
const SINGULARITY_DURATION = 3;
const SINGULARITY_RADIUS = 24;
const SINGULARITY_PLACEMENT_DISTANCE = 170;
const DUPLICATE_EXPLOSIVE_CHANCE = 0.62;
const DUPLICATE_ENEMY_CHANCE = 0.22;
const DUPLICATE_POWERUP_CHANCE = 0.05;
const POWERUP_WEIGHTS: Record<TemporaryPowerupKind, number> = {
  "machine-gun": 2,
  "super-shot": 1.6,
  shield: 1.4,
  reflect: 1,
  prism: 1,
  freeze: 0.35,
  singularity: 0.35,
  repair: 1.2,
};

interface CreateGameOptions {
  mode?: DifficultyMode;
  weapon?: WeaponKind;
  seed?: number;
  checkpoint?: ArcadeCheckpoint | null;
  phase?: GameState["phase"];
}

export function createGameState(
  width: number,
  height: number,
  options: CreateGameOptions = {},
): GameState {
  const checkpoint = options.checkpoint;
  const seed = checkpoint?.seed ?? options.seed ?? createSeed();
  const maxHealth = checkpoint?.maxHealth ?? 3;
  const state: GameState = {
    width,
    height,
    seed,
    rngState: seed || 1,
    mode: checkpoint?.mode ?? options.mode ?? "normal",
    phase: options.phase ?? (checkpoint ? "encounter" : "title"),
    actIndex: checkpoint?.actIndex ?? 0,
    encounterIndex: 0,
    endlessRound: 0,
    weapon: checkpoint?.weapon ?? options.weapon ?? "blaster",
    player: {
      x: width / 2,
      y: height / 2,
      health: checkpoint?.health ?? maxHealth,
      maxHealth,
      shield: checkpoint?.shield ?? 0,
      angle: 0,
      invulnerableFor: 0,
      fireCooldown: 0,
      ammo: 14,
      magazineSize: 14,
      reloadFor: 0,
      reloadDuration: 0.85,
      secondaryCooldown: 0,
      beamFlashFor: 0,
      dashCooldown: 0,
      dashFor: 0,
      dashX: 0,
      dashY: 0,
    },
    enemies: [],
    projectiles: [],
    hazards: [],
    particles: [],
    score: checkpoint?.score ?? 0,
    comboCount: 0,
    comboMultiplier: 1,
    comboTimer: 0,
    elapsed: 0,
    phaseElapsed: 0,
    objectiveProgress: 0,
    objectiveTarget: 0,
    kills: 0,
    enemyHits: 0,
    shieldBlocks: 0,
    bossPhaseChanges: 0,
    noDamage: true,
    spawnCooldown: 0.6,
    spawnBeatIndex: 0,
    spawnBudgetRemaining: 0,
    upgrades: { ...checkpoint?.upgrades },
    offeredUpgrades: [],
    nextEnemyId: 1,
    nextProjectileId: 1,
    nextHazardId: 1,
    nextParticleId: 1,
    screenShake: 0,
    relayCache: null,
    relayStreak: 0,
    relayMisses: 0,
    upgradeTargets: [],
    rewardRevealFor: 0,
    rewardSelectionArmed: false,
    rewardTransitionFor: 0,
    powerupDrops: [],
    activePowerups: {
      reflect: 0,
      prism: 0,
      shieldFor: 0,
      shieldHits: 0,
      freezeFor: 0,
    },
    singularity: null,
    temporaryWeapon: null,
    nextPowerupId: 1,
    dropCooldown: 0,
    killsSincePowerupDrop: 0,
    powerupsDroppedThisPhase: 0,
    lastPowerupKind: null,
    powerupsCollected: 0,
    patternCooldown: 8,
    patternWarningFor: 0,
    patternSourceId: null,
    patternKind: null,
    bossDialogue: null,
    minibossDefeatFor: 0,
    banner: checkpoint ? ACTS[checkpoint.actIndex].encounters[0].name : "",
  };
  if (checkpoint || state.phase === "encounter") beginEncounter(state);
  return state;
}

// Compatibility aliases keep the pure engine convenient for existing consumers.
export const createArcadeState = createGameState;

export function createStateFromCheckpoint(
  width: number,
  height: number,
  checkpoint: ArcadeCheckpoint,
) {
  return createGameState(width, height, { checkpoint });
}

export function resizeGameState(
  state: GameState,
  width: number,
  height: number,
) {
  const previousWidth = Math.max(1, state.width);
  const previousHeight = Math.max(1, state.height);
  const scaleX = width / previousWidth;
  const scaleY = height / previousHeight;
  state.width = width;
  state.height = height;
  state.player.x = clamp(
    state.player.x * scaleX,
    PLAYER_RADIUS,
    width - PLAYER_RADIUS,
  );
  state.player.y = clamp(
    state.player.y * scaleY,
    PLAYER_RADIUS,
    height - PLAYER_RADIUS,
  );
  for (const enemy of state.enemies) {
    enemy.x = clamp(enemy.x * scaleX, -enemy.radius, width + enemy.radius);
    enemy.y = clamp(enemy.y * scaleY, -enemy.radius, height + enemy.radius);
  }
  for (const hazard of state.hazards) {
    hazard.x = clamp(hazard.x * scaleX, 0, width);
    hazard.y = clamp(hazard.y * scaleY, 0, height);
  }
}

export const resizeArcadeState = resizeGameState;

export function dispatchGameAction(state: GameState, action: GameAction) {
  switch (action.type) {
    case "start":
      resetForRun(
        state,
        action.mode,
        action.weapon,
        action.seed ?? createSeed(),
      );
      beginEncounter(state);
      break;
    case "chooseUpgrade":
      if (
        state.phase !== "reward" ||
        !state.offeredUpgrades.includes(action.upgradeId)
      ) {
        return;
      }
      applyUpgrade(state, action.upgradeId);
      finishRewardSelection(state);
      break;
    case "continueAct":
      if (state.phase !== "actComplete") return;
      if (state.actIndex >= ACTS.length - 1) {
        state.phase = "victory";
        state.banner = "Library secured";
      } else {
        state.actIndex += 1;
        state.encounterIndex = 0;
        state.player.health = Math.min(
          state.player.maxHealth,
          state.player.health + DIFFICULTIES[state.mode].recoveryHealth + 1,
        );
        beginEncounter(state);
      }
      break;
    case "restartAct": {
      const checkpoint: ArcadeCheckpoint = {
        seed: state.seed,
        mode: state.mode,
        actIndex: state.actIndex,
        weapon: state.weapon,
        score: state.score,
        upgrades: { ...state.upgrades },
        maxHealth: state.player.maxHealth,
        health: state.player.maxHealth,
        shield: upgradeLevel(state, "snapshot") > 0 ? 1 : 0,
      };
      Object.assign(
        state,
        createStateFromCheckpoint(state.width, state.height, checkpoint),
      );
      break;
    }
    case "startEndless":
      resetForRun(state, state.mode, state.weapon, createSeed());
      state.phase = "endless";
      state.endlessRound = 1;
      state.objectiveTarget = 90;
      state.banner = "Endless maintenance";
      state.spawnBudgetRemaining = 32;
      state.spawnCooldown = 0.5;
      resetDropDirector(state);
      break;
    case "returnToTitle":
      state.phase = "title";
      clearArena(state);
      state.banner = "";
      break;
  }
}

export function stepGame(
  state: GameState,
  input: ArcadeInput,
  delta: number,
  randomOverride?: () => number,
) {
  if (
    state.phase !== "encounter" &&
    state.phase !== "reward" &&
    state.phase !== "miniboss" &&
    state.phase !== "boss" &&
    state.phase !== "endless"
  ) {
    return;
  }

  const dt = Math.min(delta, 1 / 20);
  const random = randomOverride ?? (() => nextRandom(state));
  state.elapsed += dt;
  state.phaseElapsed += dt;
  state.screenShake = Math.max(0, state.screenShake - dt * 2.8);
  updateTimers(state, dt);
  if (state.phase === "reward" && !input.firing) {
    state.rewardSelectionArmed = true;
  }
  const playerInput = state.phase === "reward" &&
      (state.rewardRevealFor > 0 || !state.rewardSelectionArmed)
    ? { ...input, firing: false }
    : input;
  updatePlayer(state, playerInput, dt);
  if (state.phase === "reward") {
    if (state.rewardRevealFor > 0) {
      state.rewardRevealFor = Math.max(0, state.rewardRevealFor - dt);
      state.projectiles = [];
      if (state.rewardRevealFor === 0) {
        state.upgradeTargets = createUpgradeTargets(state);
        state.player.ammo = state.player.magazineSize;
        state.player.reloadFor = 0;
      }
    }
    if (state.rewardTransitionFor > 0) {
      state.rewardTransitionFor = Math.max(0, state.rewardTransitionFor - dt);
      if (state.rewardTransitionFor === 0) {
        finishRewardSelection(state);
        return;
      }
    }
    updateProjectiles(state, dt);
    resolveUpgradeTargetCollisions(state);
    updateParticles(state, dt);
    compactState(state);
    return;
  }
  updateSpawns(state, dt, random);
  const frozen = state.activePowerups.freezeFor > 0;
  if (!frozen) updatePatternDirector(state, dt);
  updateProjectiles(state, dt, frozen);
  if (!frozen) updateEnemies(state, dt, random);
  updateSingularity(state, dt, random);
  updateHazards(state, dt);
  resolveProjectileCollisions(state, random);
  resolvePlayerCollisions(state);
  updateParticles(state, dt);
  updateObjective(state, dt);
  updatePowerupDrops(state, dt);
  compactState(state);
}

export const stepArcade = stepGame;

export function getCurrentEncounter(
  state: GameState,
): EncounterDefinition | null {
  if (state.phase === "endless") return null;
  return ACTS[state.actIndex]?.encounters[state.encounterIndex] ?? null;
}

export function getObjectiveLabel(state: GameState) {
  if (
    state.phase !== "encounter" &&
    state.phase !== "miniboss" &&
    state.phase !== "boss" &&
    state.phase !== "endless"
  ) {
    return "";
  }
  if (state.phase === "boss" || state.phase === "miniboss") {
    if (state.phase === "miniboss" && state.minibossDefeatFor > 0) {
      return "Process terminated";
    }
    const boss = state.enemies.find((enemy) => enemy.kind === "boss");
    const label = state.phase === "miniboss" ? "Miniboss" : "Boss";
    return boss ? `${label} integrity ${Math.max(0, Math.ceil(boss.health))}` : `${label} incoming`;
  }
  if (state.phase === "endless") return `Round ${state.endlessRound}`;
  const encounter = getCurrentEncounter(state);
  if (!encounter) return "";
  if (encounter.objective === "purge") {
    return `${Math.floor(state.objectiveProgress)} / ${state.objectiveTarget} GB`;
  }
  if (encounter.objective === "relay") {
    const seconds = state.relayCache ? Math.max(0, state.relayCache.timeRemaining).toFixed(1) : "—";
    return `${Math.floor(state.objectiveProgress)} / ${state.objectiveTarget} caches · ${seconds}s`;
  }
  return `${Math.max(0, Math.ceil(state.objectiveTarget - state.objectiveProgress))}s remaining`;
}

export function getActProgress(state: GameState) {
  if (state.phase === "boss") return 1;
  if (state.phase === "miniboss") return 0.5;
  if (state.phase === "actComplete" || state.phase === "victory") return 1;
  return clamp(
    (state.encounterIndex +
      state.objectiveProgress / Math.max(1, state.objectiveTarget)) /
      4,
    0,
    1,
  );
}

function resetForRun(
  state: GameState,
  mode: DifficultyMode,
  weapon: WeaponKind,
  seed: number,
) {
  const fresh = createGameState(state.width, state.height, {
    mode,
    weapon,
    seed,
    phase: "title",
  });
  Object.assign(state, fresh);
}

function beginEncounter(state: GameState) {
  const encounter = ACTS[state.actIndex].encounters[state.encounterIndex];
  state.phase = "encounter";
  state.phaseElapsed = 0;
  state.objectiveProgress = 0;
  state.objectiveTarget = encounter.target;
  state.spawnBeatIndex = 0;
  state.spawnBudgetRemaining = adjustedBudget(state, encounter.beats[0].budget);
  state.spawnCooldown = 0.08;
  state.noDamage = true;
  state.offeredUpgrades = [];
  state.upgradeTargets = [];
  state.rewardRevealFor = 0;
  state.rewardSelectionArmed = false;
  state.rewardTransitionFor = 0;
  state.relayStreak = 0;
  state.relayMisses = 0;
  state.patternCooldown = 8;
  state.patternWarningFor = 0;
  state.patternSourceId = null;
  state.patternKind = null;
  state.banner = encounter.name;
  resetDropDirector(state);
  preparePlayerForPhase(state);
  clearArena(state);
  while (
    state.enemies.length < encounter.openingThreats &&
    state.enemies.length < MAX_ENEMIES
  ) {
    const kind = chooseWeightedKind(encounter.beats[0].weights, () => nextRandom(state));
    state.enemies.push(spawnEnemy(state, kind, () => nextRandom(state)));
  }
  if (encounter.objective === "relay") spawnRelayCache(state);
}

function beginBoss(state: GameState) {
  state.phase = "boss";
  state.phaseElapsed = 0;
  state.objectiveProgress = 0;
  state.objectiveTarget = ACTS[state.actIndex].boss.health;
  state.noDamage = true;
  state.spawnBudgetRemaining = 0;
  state.banner = ACTS[state.actIndex].boss.name;
  resetDropDirector(state);
  preparePlayerForPhase(state);
  clearArena(state);
  state.enemies.push(createBoss(state));
}

function beginMiniboss(state: GameState) {
  const miniboss = ACTS[state.actIndex].miniboss;
  if (!miniboss) return;
  state.phase = "miniboss";
  state.phaseElapsed = 0;
  state.objectiveProgress = 0;
  state.spawnBudgetRemaining = 0;
  state.banner = miniboss.name;
  state.minibossDefeatFor = 0;
  resetDropDirector(state);
  preparePlayerForPhase(state);
  clearArena(state);
  const enemy = createMiniboss(state);
  state.objectiveTarget = enemy.maxHealth;
  state.enemies.push(enemy);
  showBossDialogue(state, miniboss.quotes.intro, enemy.x, enemy.y, 4.2);
}

function preparePlayerForPhase(state: GameState) {
  state.player.x = state.width / 2;
  state.player.y = state.height / 2;
  state.player.invulnerableFor = 1;
  state.player.dashFor = 0;
  configureWeaponState(state, true);
  state.player.secondaryCooldown = 0;
  if (upgradeLevel(state, "snapshot") > 0) {
    state.player.shield = Math.max(1, state.player.shield);
  }
}

function clearArena(state: GameState) {
  state.enemies = [];
  state.projectiles = [];
  state.hazards = [];
  state.particles = [];
  state.powerupDrops = [];
  state.relayCache = null;
  state.bossDialogue = null;
  state.singularity = null;
  state.activePowerups.freezeFor = 0;
}

function updateTimers(state: GameState, dt: number) {
  state.player.invulnerableFor = Math.max(0, state.player.invulnerableFor - dt);
  state.player.fireCooldown = Math.max(0, state.player.fireCooldown - dt);
  if (state.player.reloadFor > 0) {
    state.player.reloadFor = Math.max(0, state.player.reloadFor - dt);
    if (state.player.reloadFor === 0) {
      if (state.temporaryWeapon) {
        state.temporaryWeapon.ammo = temporaryWeaponMagazineSize(
          state.temporaryWeapon.kind,
        );
      } else {
        state.player.ammo = state.player.magazineSize;
      }
    }
  }
  state.player.secondaryCooldown = Math.max(
    0,
    state.player.secondaryCooldown - dt,
  );
  state.activePowerups.freezeFor = Math.max(0, state.activePowerups.freezeFor - dt);
  state.player.beamFlashFor = Math.max(0, state.player.beamFlashFor - dt);
  state.player.dashCooldown = Math.max(0, state.player.dashCooldown - dt);
  state.player.dashFor = Math.max(0, state.player.dashFor - dt);
  state.dropCooldown = Math.max(0, state.dropCooldown - dt);
  if (state.bossDialogue) {
    state.bossDialogue.life = Math.max(0, state.bossDialogue.life - dt);
    if (state.bossDialogue.life === 0) state.bossDialogue = null;
  }
  for (const target of state.upgradeTargets) {
    target.entranceFor = Math.max(0, target.entranceFor - dt);
  }
  state.comboTimer = Math.max(0, state.comboTimer - dt);
  if (state.comboTimer === 0) {
    state.comboCount = 0;
    state.comboMultiplier = 1;
  }
}

function updatePlayer(state: GameState, input: ArcadeInput, dt: number) {
  const movementLength = Math.hypot(input.movement.x, input.movement.y);
  const movementX = movementLength > 0 ? input.movement.x / movementLength : 0;
  const movementY = movementLength > 0 ? input.movement.y / movementLength : 0;

  if (input.dash && state.player.dashCooldown === 0 && movementLength > 0) {
    state.player.dashFor = BASE_DASH_DURATION * (1 + upgradeLevel(state, "checksum") * 0.2);
    state.player.dashCooldown = BASE_DASH_COOLDOWN *
      Math.pow(0.82, upgradeLevel(state, "io-burst"));
    state.player.dashX = movementX;
    state.player.dashY = movementY;
    state.player.invulnerableFor = Math.max(
      state.player.invulnerableFor,
      state.player.dashFor + 0.06,
    );
    burstParticles(
      state,
      state.player.x,
      state.player.y,
      ACTS[state.actIndex].palette.primary,
      9,
    );
  }

  const speed = state.player.dashFor > 0
    ? DASH_SPEED
    : BASE_PLAYER_SPEED * (1 + upgradeLevel(state, "fast-scan") * 0.1);
  const moveX = state.player.dashFor > 0 ? state.player.dashX : movementX;
  const moveY = state.player.dashFor > 0 ? state.player.dashY : movementY;
  state.player.x = clamp(
    state.player.x + moveX * speed * dt,
    PLAYER_RADIUS,
    state.width - PLAYER_RADIUS,
  );
  state.player.y = clamp(
    state.player.y + moveY * speed * dt,
    PLAYER_RADIUS,
    state.height - PLAYER_RADIUS,
  );

  const aimX = input.aim.x - state.player.x;
  const aimY = input.aim.y - state.player.y;
  if (Math.hypot(aimX, aimY) > 0.001) {
    state.player.angle = Math.atan2(aimY, aimX);
  }

  if (input.reload) startReload(state);
  if (input.secondary && state.player.secondaryCooldown === 0) {
    fireDeepScan(state);
  }
  if (input.firing && state.player.fireCooldown === 0) {
    if (state.player.reloadFor > 0) return;
    const ammo = state.temporaryWeapon?.ammo ?? state.player.ammo;
    if (ammo <= 0) startReload(state);
    else fireWeapon(state);
  }
}

function fireWeapon(state: GameState) {
  if (state.projectiles.length >= MAX_PROJECTILES) return;
  const temporaryKind = state.temporaryWeapon?.kind ?? null;
  const fireRate = Math.pow(0.86, upgradeLevel(state, "rapid-index"));
  const baseInterval = temporaryKind === "machine-gun"
    ? 0.075
    : temporaryKind === "super-shot"
    ? 0.45
    : state.weapon === "rail"
    ? 0.42
    : state.weapon === "array"
    ? 0.22
    : BASE_FIRE_INTERVAL;
  state.player.fireCooldown = Math.max(0.055, baseInterval * fireRate);
  if (state.temporaryWeapon) {
    state.temporaryWeapon.ammo -= 1;
  } else {
    state.player.ammo = Math.max(0, state.player.ammo - 1);
    if (state.player.ammo === 0) startReload(state);
  }

  const companionShots = upgradeLevel(state, "parallel-writes");
  const weaponShots = temporaryKind ? 1 : state.weapon === "array" ? 3 : 1;
  const totalShots = weaponShots + companionShots;
  const spread = totalShots === 1
    ? 0
    : temporaryKind
    ? 0.075
    : state.weapon === "array"
    ? 0.18
    : 0.075;
  for (let index = 0; index < totalShots; index++) {
    const offset = (index - (totalShots - 1) / 2) * spread;
    createFriendlyProjectile(state, state.player.angle + offset, temporaryKind);
  }
  if (state.temporaryWeapon?.ammo === 0) startReload(state);
}

function createFriendlyProjectile(
  state: GameState,
  angle: number,
  temporaryKind: TemporaryWeaponKind | null = null,
) {
  const rail = state.weapon === "rail";
  const packetSize = upgradeLevel(state, "packet-size");
  const damage = temporaryKind === "machine-gun"
    ? 1 + Math.floor(packetSize / 2)
    : temporaryKind === "super-shot"
    ? 8 + packetSize
    : (rail ? 2 : 1) + packetSize;
  const radius = temporaryKind === "super-shot" ? 9 : temporaryKind ? 3 : rail ? 4 : 3;
  const speed = temporaryKind === "machine-gun"
    ? 690
    : temporaryKind === "super-shot"
    ? 720
    : BASE_PROJECTILE_SPEED * (rail ? 1.28 : 1);
  const baseLife = temporaryKind === "super-shot" ? 1.25 : temporaryKind ? 1.18 : rail ? 0.9 : 1.18;
  const reflected = state.activePowerups.reflect > 0;
  state.projectiles.push({
    id: state.nextProjectileId++,
    x: state.player.x + Math.cos(angle) * 21,
    y: state.player.y + Math.sin(angle) * 21,
    previousX: state.player.x,
    previousY: state.player.y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    radius,
    damage,
    pierce: (temporaryKind === "super-shot" ? 6 : temporaryKind ? 0 : rail ? 2 : 0) +
      upgradeLevel(state, "dedupe-pass") +
      (state.activePowerups.prism > 0 ? 1 : 0),
    life: baseLife * (reflected ? REFLECT_LIFE_MULTIPLIER : 1),
    friendly: true,
    hitIds: [],
    bouncesRemaining: reflected ? REFLECT_BOUNCES : 0,
    reflected,
  });
}

function configureWeaponState(state: GameState, refill: boolean) {
  const baseMagazine = state.weapon === "rail" ? 5 : state.weapon === "array" ? 9 : 14;
  const baseReload = state.weapon === "rail" ? 1.1 : state.weapon === "array" ? 1 : 0.85;
  state.player.magazineSize = Math.ceil(
    baseMagazine * (1 + upgradeLevel(state, "magazine-extension") * 0.25),
  );
  state.player.reloadDuration = Math.max(
    0.28,
    baseReload * Math.pow(0.84, upgradeLevel(state, "hot-swap")),
  );
  if (refill) {
    state.player.ammo = state.player.magazineSize;
    state.player.reloadFor = 0;
  } else {
    state.player.ammo = Math.min(state.player.ammo, state.player.magazineSize);
  }
}

function startReload(state: GameState) {
  if (state.player.reloadFor > 0) return;
  if (state.temporaryWeapon) {
    const magazineSize = temporaryWeaponMagazineSize(
      state.temporaryWeapon.kind,
    );
    if (state.temporaryWeapon.ammo >= magazineSize) return;
    const baseDuration = state.temporaryWeapon.kind === "machine-gun"
      ? MACHINE_GUN_RELOAD
      : SUPER_SHOT_RELOAD;
    state.player.reloadFor = Math.max(
      0.45,
      baseDuration * Math.pow(0.84, upgradeLevel(state, "hot-swap")),
    );
    return;
  }
  if (state.player.ammo >= state.player.magazineSize) return;
  state.player.reloadFor = state.player.reloadDuration;
}

function temporaryWeaponMagazineSize(kind: TemporaryWeaponKind) {
  return kind === "machine-gun" ? MACHINE_GUN_AMMO : SUPER_SHOT_AMMO;
}

function fireDeepScan(state: GameState) {
  const cooldown = Math.max(
    4.6,
    BASE_SECONDARY_COOLDOWN *
      Math.pow(0.88, upgradeLevel(state, "index-accelerator")),
  );
  state.player.secondaryCooldown = cooldown;
  state.player.beamFlashFor = 0.16;
  const forked = upgradeLevel(state, "forked-scan") > 0 || state.activePowerups.prism > 0;
  const angles = forked
    ? [state.player.angle - 0.18, state.player.angle, state.player.angle + 0.18]
    : [state.player.angle];
  const width = DEEP_SCAN_BASE_WIDTH * Math.pow(1.3, upgradeLevel(state, "wide-query"));
  let bossHit = false;
  let hitSomething = false;
  for (let angleIndex = 0; angleIndex < angles.length; angleIndex++) {
    const angle = angles[angleIndex];
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const beamDamage = angleIndex === Math.floor(angles.length / 2) ? 5 : 3;
    for (const enemy of state.enemies) {
      if (enemy.health <= 0) continue;
      const dx = enemy.x - state.player.x;
      const dy = enemy.y - state.player.y;
      const along = dx * direction.x + dy * direction.y;
      const across = Math.abs(dx * direction.y - dy * direction.x);
      if (along < 0 || across > enemy.radius + width) continue;
      if (enemy.kind === "boss") {
        if (bossHit) continue;
        bossHit = true;
        enemy.health -= 4;
        if (enemy.bossKind === "backlog") {
          enemy.x = clamp(
            enemy.x + direction.x * DEEP_SCAN_BACKLOG_KNOCKBACK,
            enemy.radius,
            state.width - enemy.radius,
          );
          enemy.y = clamp(
            enemy.y + direction.y * DEEP_SCAN_BACKLOG_KNOCKBACK,
            enemy.radius,
            state.height - enemy.radius,
          );
        }
      } else {
        enemy.health -= beamDamage;
      }
      hitSomething = true;
      if (enemy.health <= 0) {
        destroyEnemy(state, enemy, () => nextRandom(state));
      }
    }
  }
  if (hitSomething) state.enemyHits += 1;
  burstParticles(
    state,
    state.player.x + Math.cos(state.player.angle) * 38,
    state.player.y + Math.sin(state.player.angle) * 38,
    "#70dff2",
    16,
  );
  state.screenShake = Math.max(state.screenShake, 0.42);
}

function updateSpawns(state: GameState, dt: number, random: () => number) {
  if (state.phase === "boss" || state.phase === "miniboss") return;
  if (state.phase === "endless") {
    updateEndlessSpawns(state, dt, random);
    return;
  }

  const encounter = getCurrentEncounter(state);
  if (!encounter) return;
  const nextBeat = encounter.beats[state.spawnBeatIndex + 1];
  if (nextBeat && state.phaseElapsed >= nextBeat.at) {
    state.spawnBeatIndex += 1;
    state.spawnBudgetRemaining += adjustedBudget(state, nextBeat.budget);
  }

  state.spawnCooldown -= dt;
  const hardDensity = state.mode === "hard" ? 1.3 : 1;
  const threat = currentThreat(state);
  const threatFloor = Math.round(encounter.threatFloor * hardDensity);
  const threatCap = Math.round(encounter.threatCap * hardDensity);
  if (threat < threatFloor && state.spawnBudgetRemaining <= 0) {
    state.spawnBudgetRemaining = Math.max(1, threatCap - threat);
  }
  if (
    state.spawnCooldown > 0 ||
    state.spawnBudgetRemaining <= 0 ||
    threat >= threatCap
  ) {
    return;
  }
  const beat = encounter.beats[state.spawnBeatIndex];
  const kind = chooseWeightedKind(beat.weights, random);
  const cost = enemyCost(kind);
  if (
    state.spawnBudgetRemaining >= cost &&
    state.enemies.length < MAX_ENEMIES
  ) {
    state.enemies.push(spawnEnemy(state, kind, random));
    state.spawnBudgetRemaining -= cost;
  } else {
    state.spawnBudgetRemaining = 0;
  }
  state.spawnCooldown = (encounter.replenishMin +
    random() * (encounter.replenishMax - encounter.replenishMin)) /
    (state.mode === "hard" ? 1.12 : 1);
}

function currentThreat(state: GameState) {
  return state.enemies.reduce(
    (total, enemy) => total + (enemy.kind === "boss" ? 0 : enemyCost(enemy.kind)),
    0,
  );
}

function updatePatternDirector(state: GameState, dt: number) {
  if (state.phase !== "encounter" || state.phaseElapsed < 10) return;
  if (state.patternWarningFor > 0) {
    state.patternWarningFor = Math.max(0, state.patternWarningFor - dt);
    if (state.patternWarningFor === 0) {
      const source = state.enemies.find(
        (enemy) => enemy.id === state.patternSourceId,
      );
      if (source && source.health > 0) {
        if (state.patternKind === "aimed") {
          aimedSpread(
            state,
            source,
            3 + state.actIndex,
            0.18,
            205 + state.actIndex * 20,
          );
        } else {
          radialBurst(
            state,
            source,
            6 + state.actIndex * 2,
            175 + state.actIndex * 20,
          );
        }
      }
      state.patternSourceId = null;
      state.patternKind = null;
      state.patternCooldown = Math.max(2.2, 5.2 - state.actIndex * 0.75) *
        (state.mode === "hard" ? 0.78 : 1);
    }
    return;
  }
  state.patternCooldown -= dt;
  if (state.patternCooldown > 0) return;
  const encounter = getCurrentEncounter(state);
  if (!encounter) return;
  const shooters = state.enemies.filter(
    (enemy) => enemy.health > 0 && enemy.kind !== "boss" && enemy.kind !== "file",
  );
  if (shooters.length > 0) {
    const source = shooters[Math.floor(nextRandom(state) * shooters.length)];
    source.warningFor = Math.max(
      source.warningFor,
      state.mode === "hard" ? 0.4 : 0.5,
    );
    state.patternWarningFor = state.mode === "hard" ? 0.4 : 0.5;
    state.patternSourceId = source.id;
    state.patternKind = encounter.objective === "relay" ? "aimed" : "radial";
    return;
  }
  state.patternCooldown = Math.max(2.2, 5.2 - state.actIndex * 0.75) *
    (state.mode === "hard" ? 0.78 : 1);
}

function updateEndlessSpawns(
  state: GameState,
  dt: number,
  random: () => number,
) {
  const roundDuration = 75;
  const expectedRound = 1 + Math.floor(state.phaseElapsed / roundDuration);
  if (expectedRound > state.endlessRound) {
    state.endlessRound = expectedRound;
    state.spawnBudgetRemaining += 28 + expectedRound * 7;
    state.player.health = Math.min(
      state.player.maxHealth,
      state.player.health + 1,
    );
    state.banner = `Maintenance cycle ${expectedRound}`;
    state.killsSincePowerupDrop = 0;
    state.powerupsDroppedThisPhase = 0;
  }
  state.spawnCooldown -= dt;
  if (state.spawnCooldown > 0) return;
  if (state.spawnBudgetRemaining <= 0) {
    state.spawnBudgetRemaining = 18 + state.endlessRound * 4;
  }
  const actWeights = state.endlessRound % 3 === 1
    ? ACTS[0].encounters[2].beats[2].weights
    : state.endlessRound % 3 === 2
    ? ACTS[1].encounters[2].beats[2].weights
    : ACTS[2].encounters[2].beats[2].weights;
  const kind = chooseWeightedKind(actWeights, random);
  const cost = enemyCost(kind);
  if (state.enemies.length < MAX_ENEMIES) {
    state.enemies.push(
      spawnEnemy(state, kind, random, 1 + state.endlessRound * 0.045),
    );
    state.spawnBudgetRemaining -= cost;
  }
  state.spawnCooldown = Math.max(0.24, 0.72 - state.endlessRound * 0.025) * (0.7 + random() * 0.5);
}

function updateProjectiles(state: GameState, dt: number, freezeHostile = false) {
  for (const projectile of state.projectiles) {
    projectile.previousX = projectile.x;
    projectile.previousY = projectile.y;
    if (freezeHostile && !projectile.friendly) continue;
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;
    if (projectile.friendly && projectile.bouncesRemaining > 0) {
      let bounced = false;
      if (
        projectile.x <= projectile.radius ||
        projectile.x >= state.width - projectile.radius
      ) {
        projectile.x = clamp(
          projectile.x,
          projectile.radius,
          state.width - projectile.radius,
        );
        projectile.vx *= -1;
        bounced = true;
      }
      if (
        projectile.y <= projectile.radius ||
        projectile.y >= state.height - projectile.radius
      ) {
        projectile.y = clamp(
          projectile.y,
          projectile.radius,
          state.height - projectile.radius,
        );
        projectile.vy *= -1;
        bounced = true;
      }
      if (bounced) {
        projectile.bouncesRemaining -= 1;
        burstParticles(state, projectile.x, projectile.y, "#70dff2", 5);
      }
    }
    projectile.life -= dt;
  }
}

function updateEnemies(state: GameState, dt: number, random: () => number) {
  for (const enemy of state.enemies) {
    if (enemy.health <= 0) continue;
    enemy.behaviorCooldown -= dt;
    enemy.warningFor = Math.max(0, enemy.warningFor - dt);
    enemy.dashFor = Math.max(0, enemy.dashFor - dt);
    if (enemy.kind === "boss") {
      updateBoss(state, enemy, dt, random);
      continue;
    }

    const dx = state.player.x - enemy.x;
    const dy = state.player.y - enemy.y;
    const distance = Math.hypot(dx, dy) || 1;
    const towardX = dx / distance;
    const towardY = dy / distance;
    enemy.aimAngle = Math.atan2(dy, dx);
    const supportBoost = state.enemies.some(
        (candidate) =>
          candidate.kind === "support" &&
          candidate.id !== enemy.id &&
          Math.hypot(candidate.x - enemy.x, candidate.y - enemy.y) < 145,
      )
      ? 1.2
      : 1;

    if (enemy.kind === "malicious") {
      orbitPlayer(enemy, towardX, towardY, distance, dt, supportBoost);
      updateShooter(state, enemy, random);
    } else if (enemy.kind === "corruptor") {
      orbitPlayer(enemy, towardX, towardY, distance, dt, supportBoost * 0.82);
      if (enemy.behaviorCooldown <= 0 && state.hazards.length < MAX_HAZARDS) {
        state.hazards.push(createMine(state, enemy.x, enemy.y));
        enemy.behaviorCooldown = 2.8 + random() * 1.1;
        enemy.warningFor = 0.32;
      }
    } else if (enemy.kind === "buffering") {
      if (enemy.dashFor > 0) {
        enemy.x += enemy.dashX * enemy.speed * 4.4 * dt;
        enemy.y += enemy.dashY * enemy.speed * 4.4 * dt;
      } else if (enemy.warningFor > 0) {
        // Hold position while the bright lane telegraphs the dash.
      } else if (enemy.phase === 1) {
        enemy.dashFor = 0.34;
        enemy.phase = 0;
      } else if (enemy.behaviorCooldown <= 0) {
        enemy.warningFor = 0.52 * DIFFICULTIES[state.mode].warningMultiplier;
        enemy.behaviorCooldown = 2.6 + random() * 0.7;
        enemy.dashX = towardX;
        enemy.dashY = towardY;
        enemy.phase = 1;
      } else {
        moveEnemy(enemy, towardX, towardY, dt, supportBoost * 0.65);
      }
    } else if (enemy.kind === "support") {
      const radial = distance > 250 ? 1 : distance < 175 ? -1 : 0;
      enemy.x += (towardX * radial - towardY * enemy.orbitDirection) * enemy.speed * dt;
      enemy.y += (towardY * radial + towardX * enemy.orbitDirection) * enemy.speed * dt;
    } else {
      moveEnemy(enemy, towardX, towardY, dt, supportBoost);
    }

    enemy.x = clamp(
      enemy.x,
      -enemy.radius * 1.5,
      state.width + enemy.radius * 1.5,
    );
    enemy.y = clamp(
      enemy.y,
      -enemy.radius * 1.5,
      state.height + enemy.radius * 1.5,
    );
  }
}

function updateSingularity(state: GameState, dt: number, random: () => number) {
  const singularity = state.singularity;
  if (!singularity) return;

  singularity.life -= dt;
  for (const enemy of state.enemies) {
    if (enemy.health <= 0) continue;
    const dx = singularity.x - enemy.x;
    const dy = singularity.y - enemy.y;
    const distance = Math.hypot(dx, dy) || 1;
    const resistance = enemy.kind === "boss" ? 0.16 : enemy.elite ? 0.55 : 1;
    const pull = 310 * resistance * Math.min(1, 190 / distance);
    enemy.x += (dx / distance) * pull * dt;
    enemy.y += (dy / distance) * pull * dt;
    enemy.health -= (enemy.kind === "boss" ? 0.6 : 1.8) * dt;
    if (enemy.health <= 0) destroyEnemy(state, enemy, random);
  }

  for (const projectile of state.projectiles) {
    if (projectile.friendly || projectile.life <= 0) continue;
    const dx = singularity.x - projectile.x;
    const dy = singularity.y - projectile.y;
    const distance = Math.hypot(dx, dy) || 1;
    if (distance <= singularity.radius) {
      projectile.life = -1;
      continue;
    }
    const acceleration = 680 * Math.min(1, 220 / distance);
    projectile.vx += (dx / distance) * acceleration * dt;
    projectile.vy += (dy / distance) * acceleration * dt;
  }

  if (singularity.life > 0) return;
  const collapseRadius = 115;
  for (const enemy of state.enemies) {
    if (
      enemy.health <= 0 ||
      Math.hypot(enemy.x - singularity.x, enemy.y - singularity.y) > collapseRadius
    ) {
      continue;
    }
    enemy.health -= enemy.kind === "boss" ? 3 : 7;
    if (enemy.health <= 0) destroyEnemy(state, enemy, random);
  }
  for (const projectile of state.projectiles) {
    if (
      !projectile.friendly &&
      Math.hypot(projectile.x - singularity.x, projectile.y - singularity.y) <= collapseRadius
    ) {
      projectile.life = -1;
    }
  }
  burstParticles(state, singularity.x, singularity.y, "#b687ff", 42);
  state.screenShake = Math.max(state.screenShake, 0.55);
  state.singularity = null;
}

function updateBoss(
  state: GameState,
  enemy: Enemy,
  dt: number,
  random: () => number,
) {
  const previousPhase = enemy.phase;
  const ratio = enemy.health / enemy.maxHealth;
  enemy.phase = ratio > 0.66 ? 1 : ratio > 0.33 ? 2 : 3;
  if (state.bossDialogue && enemy.bossKind === "backfill-daemon") {
    state.bossDialogue.x = enemy.x;
    state.bossDialogue.y = enemy.y;
  }
  if (enemy.phase !== previousPhase) {
    state.bossPhaseChanges += 1;
    state.banner = `Phase ${enemy.phase}`;
    state.screenShake = 0.7;
    enemy.behaviorCooldown = 1.1;
    enemy.warningFor = 0.8;
    radialBurst(state, enemy, 6 + enemy.phase * 2, 160 + enemy.phase * 22);
    if (enemy.bossKind === "backfill-daemon") {
      const quotes = ACTS[state.actIndex].miniboss?.quotes;
      const quote = enemy.phase === 2 ? quotes?.phaseTwo : quotes?.phaseThree;
      if (quote) showBossDialogue(state, quote, enemy.x, enemy.y, 3.4);
    }
  }

  const dx = state.player.x - enemy.x;
  const dy = state.player.y - enemy.y;
  const distance = Math.hypot(dx, dy) || 1;
  const tx = dx / distance;
  const ty = dy / distance;
  enemy.aimAngle = Math.atan2(dy, dx);

  if (enemy.bossKind === "backfill-daemon") {
    orbitPlayer(enemy, tx, ty, distance, dt, 0.82);
    if (enemy.behaviorCooldown <= 0) {
      enemy.warningFor = 0.5 * DIFFICULTIES[state.mode].warningMultiplier;
      radialBurst(state, enemy, 4 + enemy.phase * 2, 150 + enemy.phase * 24);
      if (enemy.phase >= 2) summonMinions(state, "file", 1, random);
      if (enemy.phase === 3) aimedSpread(state, enemy, 3, 0.18, 215);
      enemy.behaviorCooldown = enemy.phase === 1 ? 1.35 : enemy.phase === 2 ? 1.15 : 0.95;
    }
  } else if (enemy.bossKind === "backlog") {
    moveEnemy(enemy, tx, ty, dt, 0.7 + enemy.phase * 0.12);
    if (enemy.behaviorCooldown <= 0) {
      enemy.warningFor = 0.5 * DIFFICULTIES[state.mode].warningMultiplier;
      radialBurst(state, enemy, 5 + enemy.phase * 2, 175 + enemy.phase * 20);
      if (enemy.phase >= 2) summonMinions(state, "file", 1, random);
      enemy.behaviorCooldown = enemy.phase === 1 ? 1.65 : enemy.phase === 2 ? 1.35 : 1.1;
    }
  } else if (enemy.bossKind === "hydra") {
    orbitPlayer(enemy, tx, ty, distance, dt, 0.75);
    if (enemy.behaviorCooldown <= 0) {
      enemy.warningFor = 0.58 * DIFFICULTIES[state.mode].warningMultiplier;
      radialBurst(state, enemy, 7 + enemy.phase * 3, 155 + enemy.phase * 25);
      summonMinions(state, "duplicate", Math.min(2, enemy.phase), random);
      enemy.behaviorCooldown = enemy.phase === 1 ? 1.45 : enemy.phase === 2 ? 1.25 : 1.05;
    }
  } else {
    orbitPlayer(enemy, tx, ty, distance, dt, 0.9);
    if (enemy.behaviorCooldown <= 0) {
      enemy.warningFor = 0.44 * DIFFICULTIES[state.mode].warningMultiplier;
      aimedSpread(state, enemy, enemy.phase + 2, 0.12, 225 + enemy.phase * 20);
      if (enemy.phase >= 2 && state.hazards.length < MAX_HAZARDS) {
        state.hazards.push(
          createMine(
            state,
            clamp(
              state.player.x + (random() - 0.5) * 150,
              50,
              state.width - 50,
            ),
            clamp(
              state.player.y + (random() - 0.5) * 150,
              50,
              state.height - 50,
            ),
          ),
        );
      }
      if (enemy.phase === 3) summonMinions(state, "support", 1, random);
      enemy.behaviorCooldown = enemy.phase === 1 ? 1.1 : enemy.phase === 2 ? 0.9 : 0.72;
    }
  }
  enemy.x = clamp(enemy.x, enemy.radius, state.width - enemy.radius);
  enemy.y = clamp(enemy.y, enemy.radius, state.height - enemy.radius);
}

function updateShooter(state: GameState, enemy: Enemy, random: () => number) {
  if (enemy.behaviorCooldown > 0) {
    if (
      enemy.behaviorCooldown <
        0.46 * DIFFICULTIES[state.mode].warningMultiplier
    ) {
      enemy.warningFor = Math.max(enemy.warningFor, enemy.behaviorCooldown);
    }
    return;
  }
  aimedSpread(state, enemy, state.mode === "hard" ? 2 : 1, 0.13, 215);
  enemy.behaviorCooldown = 1.65 + random() * 0.55;
}

function updateHazards(state: GameState, dt: number) {
  for (const hazard of state.hazards) {
    hazard.life -= dt;
    hazard.armFor = Math.max(0, hazard.armFor - dt);
    if (hazard.kind === "corruption") {
      hazard.radius = Math.min(74, hazard.radius + dt * 12);
    }
  }
}

function resolveProjectileCollisions(state: GameState, random: () => number) {
  for (const projectile of state.projectiles) {
    if (projectile.life <= 0 || !projectile.friendly) continue;
    for (const enemy of state.enemies) {
      if (
        enemy.health <= 0 ||
        projectile.hitIds.includes(enemy.id) ||
        !segmentHitsCircle(projectile, enemy, enemy.radius + projectile.radius)
      ) {
        continue;
      }
      projectile.hitIds.push(enemy.id);
      const damage = state.activePowerups.freezeFor > 0
        ? projectile.damage * FROZEN_DAMAGE_MULTIPLIER
        : projectile.damage;
      enemy.health -= damage;
      state.enemyHits += 1;
      burstParticles(
        state,
        projectile.x,
        projectile.y,
        state.activePowerups.freezeFor > 0 ? "#b9f4ff" : enemyColor(enemy),
        state.activePowerups.freezeFor > 0 ? 7 : 3,
      );
      if (enemy.health <= 0) destroyEnemy(state, enemy, random);
      if (projectile.pierce <= 0) {
        projectile.life = -1;
        break;
      }
      projectile.pierce -= 1;
    }
  }

  if (state.player.invulnerableFor > 0) return;
  const hostile = state.projectiles.find(
    (projectile) =>
      projectile.life > 0 &&
      !projectile.friendly &&
      segmentHitsCircle(
        projectile,
        state.player,
        PLAYER_RADIUS + projectile.radius,
      ),
  );
  if (hostile) {
    hostile.life = -1;
    damagePlayer(state, 1, "Hostile traffic breached the archive.");
  }
}

function resolvePlayerCollisions(state: GameState) {
  if (state.player.invulnerableFor > 0) return;
  const enemy = state.enemies.find(
    (candidate) =>
      candidate.health > 0 &&
      Math.hypot(candidate.x - state.player.x, candidate.y - state.player.y) <=
        candidate.radius + PLAYER_RADIUS,
  );
  if (enemy) {
    if (enemy.kind !== "boss") enemy.health = 0;
    damagePlayer(state, enemy.damage, "The library was overrun.");
    return;
  }

  const hazard = state.hazards.find(
    (candidate) =>
      candidate.life > 0 &&
      candidate.armFor === 0 &&
      Math.hypot(candidate.x - state.player.x, candidate.y - state.player.y) <=
        candidate.radius + PLAYER_RADIUS,
  );
  if (hazard) {
    hazard.life = -1;
    damagePlayer(
      state,
      hazard.damage,
      "Corrupt sectors overwhelmed the scanner.",
    );
  }
}

function updateParticles(state: GameState, dt: number) {
  for (const particle of state.particles) {
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vx *= 0.96;
    particle.vy *= 0.96;
    particle.life -= dt;
  }
}

function updateObjective(state: GameState, dt: number) {
  if (state.phase === "miniboss") {
    if (state.minibossDefeatFor > 0) {
      state.minibossDefeatFor = Math.max(0, state.minibossDefeatFor - dt);
      if (state.minibossDefeatFor === 0) completeEncounter(state);
      return;
    }
    const miniboss = state.enemies.find(
      (enemy) => enemy.kind === "boss" && enemy.health > 0,
    );
    if (!miniboss) completeMiniboss(state);
    else state.objectiveProgress = miniboss.maxHealth - miniboss.health;
    return;
  }
  if (state.phase === "boss") {
    const boss = state.enemies.find(
      (enemy) => enemy.kind === "boss" && enemy.health > 0,
    );
    if (!boss) completeBoss(state);
    else state.objectiveProgress = boss.maxHealth - boss.health;
    return;
  }
  if (state.phase === "endless") {
    state.objectiveProgress = state.phaseElapsed;
    return;
  }

  const encounter = getCurrentEncounter(state);
  if (!encounter) return;
  if (encounter.objective === "relay") {
    updateRelayObjective(state, encounter, dt);
  } else if (encounter.objective === "survive") {
    state.objectiveProgress += dt;
  }

  if (state.objectiveProgress >= state.objectiveTarget) {
    completeEncounter(state);
  }
}

function updateRelayObjective(
  state: GameState,
  encounter: EncounterDefinition,
  dt: number,
) {
  if (!state.relayCache) {
    spawnRelayCache(state);
    return;
  }
  const cache = state.relayCache;
  cache.arrivalFor = Math.max(0, cache.arrivalFor - dt);
  cache.timeRemaining -= dt;
  const collected = Math.hypot(state.player.x - cache.x, state.player.y - cache.y) <=
    PLAYER_RADIUS + cache.radius;
  if (collected) {
    state.objectiveProgress += 1;
    state.relayStreak += 1;
    state.score += 35 * state.relayStreak * (state.actIndex + 1);
    burstParticles(
      state,
      cache.x,
      cache.y,
      ACTS[state.actIndex].palette.primary,
      18,
    );
    state.relayCache = null;
    if (state.objectiveProgress < state.objectiveTarget) spawnRelayCache(state);
  } else if (cache.timeRemaining <= 0) {
    state.relayStreak = 0;
    state.relayMisses += 1;
    if (state.phase === "encounter") {
      state.relayCache = null;
      spawnRelayCache(state);
    }
  }

  if (state.objectiveProgress >= state.objectiveTarget) {
    if (state.relayMisses === 0) state.score += 400 * (state.actIndex + 1);
  }
  void encounter;
}

function spawnRelayCache(state: GameState) {
  const encounter = getCurrentEncounter(state);
  if (!encounter || encounter.objective !== "relay") return;
  const duration = (encounter.relayDuration ?? 7) * (state.mode === "hard" ? 0.85 : 1);
  const margin = 48;
  const minDistance = Math.min(state.width, state.height) * 0.35;
  const maxDistance = BASE_PLAYER_SPEED * duration * 0.78;
  let best = { x: state.width / 2, y: state.height / 2, distance: 0 };
  for (let attempt = 0; attempt < 12; attempt++) {
    const x = margin + nextRandom(state) * Math.max(1, state.width - margin * 2);
    const y = margin + nextRandom(state) * Math.max(1, state.height - margin * 2);
    const distance = Math.hypot(x - state.player.x, y - state.player.y);
    if (distance > best.distance) best = { x, y, distance };
    if (distance >= minDistance && distance <= maxDistance) {
      best = { x, y, distance };
      break;
    }
  }
  state.relayCache = {
    x: best.x,
    y: best.y,
    radius: RELAY_RADIUS,
    duration,
    timeRemaining: duration,
    arrivalFor: 0.45,
  };
}

function compactState(state: GameState) {
  state.projectiles = state.projectiles
    .filter(
      (projectile) =>
        projectile.life > 0 &&
        projectile.x > -80 &&
        projectile.x < state.width + 80 &&
        projectile.y > -80 &&
        projectile.y < state.height + 80,
    )
    .slice(-MAX_PROJECTILES);
  state.enemies = state.enemies
    .filter((enemy) => enemy.health > 0)
    .slice(-MAX_ENEMIES);
  state.hazards = state.hazards
    .filter((hazard) => hazard.life > 0)
    .slice(-MAX_HAZARDS);
  state.particles = state.particles
    .filter((particle) => particle.life > 0)
    .slice(-MAX_PARTICLES);
  state.powerupDrops = state.powerupDrops
    .filter((drop) => drop.life > 0)
    .slice(-24);
}

function completeEncounter(state: GameState) {
  if (state.phase === "encounter") {
    const miniboss = ACTS[state.actIndex].miniboss;
    if (miniboss?.afterEncounterIndex === state.encounterIndex) {
      beginMiniboss(state);
      return;
    }
  } else if (state.phase !== "miniboss") return;
  const baseBonus = 300 * (state.actIndex + 1);
  const noDamageBonus = state.noDamage ? 250 * (state.actIndex + 1) : 0;
  state.score += baseBonus + noDamageBonus;
  if (upgradeLevel(state, "self-heal") > 0) {
    state.player.health = Math.min(
      state.player.maxHealth,
      state.player.health + upgradeLevel(state, "self-heal"),
    );
  }
  state.phase = "reward";
  state.banner = state.noDamage ? "Clean sweep" : "Sector secured";
  state.offeredUpgrades = offerUpgrades(state);
  clearArena(state);
  state.upgradeTargets = [];
  state.rewardRevealFor = REWARD_REVEAL_DELAY;
  state.rewardSelectionArmed = false;
  state.player.ammo = state.player.magazineSize;
}

function completeMiniboss(state: GameState) {
  if (state.phase !== "miniboss" || state.minibossDefeatFor > 0) return;
  const definition = ACTS[state.actIndex].miniboss;
  if (!definition) return;
  const defeated = state.enemies.find(
    (enemy) => enemy.kind === "boss" && enemy.bossKind === definition.kind,
  );
  const x = defeated?.x ?? state.width / 2;
  const y = defeated?.y ?? state.height / 2;
  state.player.maxHealth += 1;
  state.player.health = state.player.maxHealth;
  state.minibossDefeatFor = 2.6;
  state.banner = "Unexpected process terminated";
  state.enemies = [];
  state.projectiles = [];
  state.hazards = [];
  state.powerupDrops = [];
  showBossDialogue(state, definition.quotes.defeat, x, y, 2.6);
}

function createUpgradeTargets(state: GameState) {
  const radius = Math.min(state.width, state.height) * 0.24;
  const centerX = state.width / 2;
  const centerY = state.height / 2;
  return state.offeredUpgrades.map((id, index) => {
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / 3);
    return {
      id,
      x: clamp(centerX + Math.cos(angle) * radius, 64, state.width - 64),
      y: clamp(
        centerY + Math.sin(angle) * radius,
        72,
        state.height - 72,
      ),
      radius: UPGRADE_TARGET_RADIUS,
      entranceFor: 0.5,
    };
  });
}

function resolveUpgradeTargetCollisions(state: GameState) {
  if (state.rewardTransitionFor > 0) return;
  for (const projectile of state.projectiles) {
    if (!projectile.friendly || projectile.life <= 0) continue;
    const target = state.upgradeTargets.find(
      (candidate) =>
        candidate.entranceFor === 0 &&
        segmentHitsCircle(
          projectile,
          candidate,
          candidate.radius + projectile.radius,
        ),
    );
    if (!target) continue;
    applyUpgrade(state, target.id);
    state.offeredUpgrades = [target.id];
    state.upgradeTargets = [];
    state.projectiles = [];
    state.player.ammo = state.player.magazineSize;
    state.player.reloadFor = 0;
    state.rewardTransitionFor = 1;
    burstParticles(state, target.x, target.y, "#f8d477", 28);
    state.screenShake = Math.max(state.screenShake, 0.7);
    return;
  }
}

function finishRewardSelection(state: GameState) {
  if (state.encounterIndex < ACTS[state.actIndex].encounters.length - 1) {
    state.encounterIndex += 1;
    beginEncounter(state);
  } else {
    beginBoss(state);
  }
}

function completeBoss(state: GameState) {
  if (state.phase !== "boss") return;
  state.score += state.noDamage ? 600 * (state.actIndex + 1) : 0;
  state.phase = "actComplete";
  state.banner = `${ACTS[state.actIndex].name} secured`;
  state.player.health = Math.min(
    state.player.maxHealth,
    state.player.health + 1,
  );
  clearArena(state);
}

function destroyEnemy(state: GameState, enemy: Enemy, random: () => number) {
  state.kills += 1;
  state.comboCount = state.comboTimer > 0 ? state.comboCount + 1 : 1;
  state.comboMultiplier = Math.min(6, 1 + Math.floor(state.comboCount / 4));
  state.comboTimer = 2.35 * (1 + upgradeLevel(state, "combo-cache") * 0.35);
  const scoreBoost = 1 + upgradeLevel(state, "compression") * 0.15;
  state.score += Math.round(enemy.points * state.comboMultiplier * scoreBoost);
  if (
    state.phase === "encounter" &&
    getCurrentEncounter(state)?.objective === "purge"
  ) {
    state.objectiveProgress += enemy.kind === "boss" ? 10 : 1;
  }
  if (upgradeLevel(state, "garbage-collector") > 0 && state.kills % 10 === 0) {
    state.player.health = Math.min(
      state.player.maxHealth,
      state.player.health + 1,
    );
  }
  burstParticles(
    state,
    enemy.x,
    enemy.y,
    enemyColor(enemy),
    enemy.kind === "boss" ? 32 : 8,
  );
  state.screenShake = Math.max(
    state.screenShake,
    enemy.kind === "boss" ? 1 : 0.18,
  );
  if (enemy.kind === "file" && state.hazards.length < MAX_HAZARDS) {
    state.hazards.push({
      id: state.nextHazardId++,
      kind: "document-burst",
      x: enemy.x,
      y: enemy.y,
      radius: DOCUMENT_BURST_RADIUS,
      life: DOCUMENT_BURST_WARNING + 0.22,
      armFor: DOCUMENT_BURST_WARNING,
      damage: 1,
    });
  }
  if (enemy.kind !== "boss") trySpawnPowerup(state, enemy, random);

  if (enemy.kind === "duplicate" && enemy.splitGeneration < 1) {
    resolveDuplicateDrop(state, enemy, random);
  }
}

function resolveDuplicateDrop(
  state: GameState,
  enemy: Enemy,
  random: () => number,
) {
  const roll = random();
  if (roll < DUPLICATE_EXPLOSIVE_CHANCE) {
    spawnDuplicateChildren(state, enemy, ["file", "file"], random);
    return;
  }
  if (roll < DUPLICATE_EXPLOSIVE_CHANCE + DUPLICATE_ENEMY_CHANCE) {
    const pool = duplicateEnemyPool(state.actIndex);
    const kind = pool[Math.floor(random() * pool.length)];
    spawnDuplicateChildren(state, enemy, [kind, kind], random);
    return;
  }

  const wantsPowerup = roll <
    DUPLICATE_EXPLOSIVE_CHANCE +
      DUPLICATE_ENEMY_CHANCE +
      DUPLICATE_POWERUP_CHANCE;
  const kind = wantsPowerup || state.player.health >= state.player.maxHealth
    ? choosePowerupKind(state, random)
    : "repair";
  if (!spawnPowerupDrop(state, kind, enemy.x, enemy.y)) {
    spawnDuplicateChildren(state, enemy, ["file", "file"], random);
  }
}

function duplicateEnemyPool(actIndex: number): EnemyKind[] {
  if (actIndex === 0) {
    return ["file", "media", "library", "malicious", "buffering"];
  }
  if (actIndex === 1) {
    return ["file", "media", "malicious", "corruptor", "buffering"];
  }
  return ["media", "malicious", "corruptor", "buffering", "support"];
}

function spawnDuplicateChildren(
  state: GameState,
  enemy: Enemy,
  kinds: [EnemyKind, EnemyKind],
  random: () => number,
) {
  for (const [index, direction] of [-1, 1].entries()) {
    const child = spawnEnemy(state, kinds[index], random, 0.78, false);
    child.x = enemy.x + direction * 9;
    child.y = enemy.y;
    child.splitGeneration = 1;
    state.enemies.push(child);
  }
}

function damagePlayer(state: GameState, amount: number, reason: string) {
  if (
    state.activePowerups.shieldFor > 0 &&
    state.activePowerups.shieldHits > 0
  ) {
    state.shieldBlocks += 1;
    state.activePowerups.shieldHits -= 1;
    if (state.activePowerups.shieldHits === 0) {
      state.activePowerups.shieldFor = 0;
    }
    burstParticles(state, state.player.x, state.player.y, "#65d6e8", 24);
  } else if (state.player.shield > 0) {
    state.shieldBlocks += 1;
    state.player.shield -= 1;
  } else {
    state.player.health -= amount;
  }
  clearRetainedPowerups(state);
  state.noDamage = false;
  state.comboTimer = 0;
  state.player.invulnerableFor = 1.05;
  state.screenShake = 0.85;
  burstParticles(state, state.player.x, state.player.y, "#ff647c", 14);
  if (state.player.health <= 0) {
    state.player.health = 0;
    state.phase = "gameOver";
    state.gameOverReason = reason;
    state.banner = "Library overrun";
  }
}

function clearRetainedPowerups(state: GameState) {
  state.activePowerups.reflect = 0;
  state.activePowerups.prism = 0;
  state.activePowerups.shieldFor = 0;
  state.activePowerups.shieldHits = 0;
  state.temporaryWeapon = null;
  state.player.reloadFor = 0;
}

function applyUpgrade(state: GameState, upgradeId: UpgradeId) {
  const definition = UPGRADE_BY_ID[upgradeId];
  const nextLevel = Math.min(
    definition.maxLevel,
    upgradeLevel(state, upgradeId) + 1,
  );
  state.upgrades[upgradeId] = nextLevel;
  if (upgradeId === "parity") {
    state.player.maxHealth += 1;
    state.player.health = Math.min(
      state.player.maxHealth,
      state.player.health + 1,
    );
  }
  if (upgradeId === "snapshot") {
    state.player.shield = Math.max(1, state.player.shield);
  }
  if (upgradeId === "magazine-extension" || upgradeId === "hot-swap") {
    configureWeaponState(state, upgradeId === "magazine-extension");
  }
}

function updatePowerupDrops(state: GameState, dt: number) {
  for (const drop of state.powerupDrops) {
    drop.life -= dt;
    if (
      drop.life > 0 &&
      Math.hypot(drop.x - state.player.x, drop.y - state.player.y) <=
        drop.radius + PLAYER_RADIUS
    ) {
      collectPowerup(state, drop.kind);
      drop.life = -1;
      burstParticles(state, drop.x, drop.y, powerupColor(drop.kind), 22);
    }
  }
}

function collectPowerup(state: GameState, kind: TemporaryPowerupKind) {
  if (kind === "reflect") state.activePowerups.reflect = 1;
  if (kind === "machine-gun") {
    state.temporaryWeapon = { kind, ammo: MACHINE_GUN_AMMO };
    state.player.reloadFor = 0;
  }
  if (kind === "super-shot") {
    state.temporaryWeapon = { kind, ammo: SUPER_SHOT_AMMO };
    state.player.reloadFor = 0;
  }
  if (kind === "prism") state.activePowerups.prism = 1;
  if (kind === "freeze") {
    state.activePowerups.freezeFor = FREEZE_DURATION;
    state.banner = "All streams paused — shatter window open";
  }
  if (kind === "singularity") {
    state.singularity = {
      x: clamp(
        state.player.x + Math.cos(state.player.angle) * SINGULARITY_PLACEMENT_DISTANCE,
        38,
        state.width - 38,
      ),
      y: clamp(
        state.player.y + Math.sin(state.player.angle) * SINGULARITY_PLACEMENT_DISTANCE,
        38,
        state.height - 38,
      ),
      life: SINGULARITY_DURATION,
      duration: SINGULARITY_DURATION,
      radius: SINGULARITY_RADIUS,
    };
    state.banner = "Database Vacuum deployed";
  }
  if (kind === "shield") {
    clearNearbyHostileProjectiles(state);
    state.activePowerups.shieldFor = 1;
    state.activePowerups.shieldHits = 1;
  }
  if (kind === "repair") {
    state.player.health = Math.min(
      state.player.maxHealth,
      state.player.health + 1,
    );
  }
  state.powerupsCollected += 1;
}

function powerupColor(kind: TemporaryPowerupKind) {
  if (kind === "reflect") return "#f8d477";
  if (kind === "machine-gun") return "#ff7d8f";
  if (kind === "super-shot") return "#ffca69";
  if (kind === "shield") return "#65d6e8";
  if (kind === "freeze") return "#b9f4ff";
  if (kind === "singularity") return "#b687ff";
  if (kind === "repair") return "#76e0c1";
  return "#b687ff";
}

function trySpawnPowerup(state: GameState, enemy: Enemy, random: () => number) {
  state.killsSincePowerupDrop += 1;
  if (
    state.powerupsDroppedThisPhase >= powerupDropCap(state) ||
    state.dropCooldown > 0
  ) {
    return;
  }
  const guaranteed = state.killsSincePowerupDrop >= DROP_PITY_KILLS;
  const chance = enemy.elite ? ELITE_DROP_CHANCE : NORMAL_DROP_CHANCE;
  if (!guaranteed && random() >= chance) return;

  const kind = choosePowerupKind(state, random);
  spawnPowerupDrop(state, kind, enemy.x, enemy.y);
}

function spawnPowerupDrop(
  state: GameState,
  kind: TemporaryPowerupKind,
  x: number,
  y: number,
) {
  if (state.powerupsDroppedThisPhase >= powerupDropCap(state)) return false;
  state.powerupDrops.push({
    id: state.nextPowerupId++,
    kind,
    x,
    y,
    radius: 13,
    life: 10,
  });
  state.dropCooldown = DROP_COOLDOWN;
  state.killsSincePowerupDrop = 0;
  state.powerupsDroppedThisPhase += 1;
  state.lastPowerupKind = kind;
  return true;
}

function powerupDropCap(state: GameState) {
  return state.phase === "boss" ? 2 : 4;
}

function choosePowerupKind(state: GameState, random: () => number) {
  let candidates = (
    Object.keys(POWERUP_WEIGHTS) as TemporaryPowerupKind[]
  ).filter(
    (kind) => kind !== "repair" || state.player.health < state.player.maxHealth,
  );
  if (candidates.length > 1 && state.lastPowerupKind) {
    candidates = candidates.filter((kind) => kind !== state.lastPowerupKind);
  }
  const total = candidates.reduce(
    (sum, kind) => sum + POWERUP_WEIGHTS[kind],
    0,
  );
  let roll = random() * total;
  for (const kind of candidates) {
    roll -= POWERUP_WEIGHTS[kind];
    if (roll <= 0) return kind;
  }
  return candidates[candidates.length - 1];
}

function clearNearbyHostileProjectiles(state: GameState) {
  for (const projectile of state.projectiles) {
    if (
      !projectile.friendly &&
      Math.hypot(
          projectile.x - state.player.x,
          projectile.y - state.player.y,
        ) <= 230
    ) {
      projectile.life = -1;
    }
  }
}

function resetDropDirector(state: GameState) {
  state.dropCooldown = 0;
  state.killsSincePowerupDrop = 0;
  state.powerupsDroppedThisPhase = 0;
}

function offerUpgrades(state: GameState) {
  const candidates = UPGRADES.filter(
    (upgrade) => upgradeLevel(state, upgrade.id) < upgrade.maxLevel,
  ).map((upgrade) => upgrade.id);
  const offered: UpgradeId[] = [];
  while (candidates.length > 0 && offered.length < 3) {
    const index = Math.floor(nextRandom(state) * candidates.length);
    offered.push(candidates.splice(index, 1)[0]);
  }
  return offered;
}

function upgradeLevel(state: GameState, id: UpgradeId) {
  return state.upgrades[id] ?? 0;
}

function spawnEnemy(
  state: GameState,
  kind: EnemyKind,
  random: () => number,
  scale = 1,
  allowElite = true,
): Enemy {
  const stats = enemyStats(kind);
  const edge = Math.floor(random() * 4);
  let x = random() * state.width;
  let y = random() * state.height;
  if (edge === 0) y = -stats.radius;
  if (edge === 1) x = state.width + stats.radius;
  if (edge === 2) y = state.height + stats.radius;
  if (edge === 3) x = -stats.radius;
  const difficulty = DIFFICULTIES[state.mode];
  const encounter = getCurrentEncounter(state);
  const eligibleElite = allowElite &&
    state.phase === "encounter" &&
    state.phaseElapsed >= 8 &&
    kind !== "file" &&
    enemyCost(kind) >= 2;
  const elite = eligibleElite && random() < (encounter?.eliteChance ?? 0);
  const eliteScale = elite ? 1.6 : 1;
  const health = Math.max(
    1,
    Math.round(
      stats.health * difficulty.enemyHealthMultiplier * scale * eliteScale,
    ),
  );
  return {
    id: state.nextEnemyId++,
    kind,
    x,
    y,
    radius: stats.radius,
    speed: stats.speed *
      difficulty.enemySpeedMultiplier *
      Math.sqrt(scale) *
      (elite ? 1.1 : 1),
    health,
    maxHealth: health,
    points: Math.round(stats.points * (elite ? 1.8 : 1)),
    damage: stats.damage,
    aimAngle: 0,
    behaviorCooldown: 0.9 + random() * 1.4,
    warningFor: 0,
    phase: 0,
    orbitDirection: random() > 0.5 ? 1 : -1,
    splitGeneration: 0,
    dashFor: 0,
    dashX: 0,
    dashY: 0,
    elite,
  };
}

function createBoss(state: GameState): Enemy {
  const boss = ACTS[state.actIndex].boss;
  const difficulty = DIFFICULTIES[state.mode];
  const health = Math.round(boss.health * difficulty.enemyHealthMultiplier);
  return {
    id: state.nextEnemyId++,
    kind: "boss",
    bossKind: boss.kind,
    x: state.width / 2,
    y: -38,
    radius: 34,
    speed: boss.speed * difficulty.enemySpeedMultiplier,
    health,
    maxHealth: health,
    points: boss.points,
    damage: 1,
    aimAngle: Math.PI / 2,
    behaviorCooldown: 1.4,
    warningFor: 0.8,
    phase: 1,
    orbitDirection: 1,
    splitGeneration: 0,
    dashFor: 0,
    dashX: 0,
    dashY: 0,
    elite: false,
  };
}

function createMiniboss(state: GameState): Enemy {
  const miniboss = ACTS[state.actIndex].miniboss;
  if (!miniboss) throw new Error("Miniboss content is missing");
  const difficulty = DIFFICULTIES[state.mode];
  const health = Math.round(miniboss.health * difficulty.enemyHealthMultiplier);
  return {
    id: state.nextEnemyId++,
    kind: "boss",
    bossKind: miniboss.kind,
    x: state.width / 2,
    y: 48,
    radius: 27,
    speed: miniboss.speed * difficulty.enemySpeedMultiplier,
    health,
    maxHealth: health,
    points: miniboss.points,
    damage: 1,
    aimAngle: Math.PI / 2,
    behaviorCooldown: 1.1,
    warningFor: 0.8,
    phase: 1,
    orbitDirection: -1,
    splitGeneration: 0,
    dashFor: 0,
    dashX: 0,
    dashY: 0,
    elite: false,
  };
}

function showBossDialogue(
  state: GameState,
  text: string,
  x: number,
  y: number,
  duration: number,
) {
  state.bossDialogue = { text, x, y, life: duration, maxLife: duration };
}

function createMine(state: GameState, x: number, y: number): Hazard {
  return {
    id: state.nextHazardId++,
    kind: "mine",
    x,
    y,
    radius: 24,
    life: 7,
    armFor: 0.85 * DIFFICULTIES[state.mode].warningMultiplier,
    damage: 1,
  };
}

function summonMinions(
  state: GameState,
  kind: EnemyKind,
  count: number,
  random: () => number,
) {
  for (
    let index = 0;
    index < count && state.enemies.length < MAX_ENEMIES;
    index++
  ) {
    state.enemies.push(spawnEnemy(state, kind, random, 0.9));
  }
}

function radialBurst(
  state: GameState,
  enemy: Enemy,
  count: number,
  speed: number,
) {
  for (let index = 0; index < count; index++) {
    createHostileProjectile(state, enemy, (Math.PI * 2 * index) / count, speed);
  }
}

function aimedSpread(
  state: GameState,
  enemy: Enemy,
  count: number,
  spread: number,
  speed: number,
) {
  for (let index = 0; index < count; index++) {
    const angle = enemy.aimAngle + (index - (count - 1) / 2) * spread;
    createHostileProjectile(state, enemy, angle, speed);
  }
}

function createHostileProjectile(
  state: GameState,
  enemy: Enemy,
  angle: number,
  speed: number,
) {
  if (state.projectiles.length >= MAX_PROJECTILES) return;
  const difficulty = DIFFICULTIES[state.mode];
  const finalSpeed = speed * difficulty.projectileSpeedMultiplier;
  state.projectiles.push({
    id: state.nextProjectileId++,
    x: enemy.x + Math.cos(angle) * (enemy.radius + 5),
    y: enemy.y + Math.sin(angle) * (enemy.radius + 5),
    previousX: enemy.x,
    previousY: enemy.y,
    vx: Math.cos(angle) * finalSpeed,
    vy: Math.sin(angle) * finalSpeed,
    radius: 4,
    damage: 1,
    pierce: 0,
    life: 4,
    friendly: false,
    hitIds: [],
    bouncesRemaining: 0,
    reflected: false,
  });
}

function moveEnemy(
  enemy: Enemy,
  towardX: number,
  towardY: number,
  dt: number,
  multiplier = 1,
) {
  enemy.x += towardX * enemy.speed * multiplier * dt;
  enemy.y += towardY * enemy.speed * multiplier * dt;
}

function orbitPlayer(
  enemy: Enemy,
  towardX: number,
  towardY: number,
  distance: number,
  dt: number,
  multiplier: number,
) {
  const radial = distance > 285 ? 1 : distance < 195 ? -1 : 0;
  const orbitWeight = radial === 0 ? 1 : 0.3;
  enemy.x += (towardX * radial - towardY * enemy.orbitDirection * orbitWeight) *
    enemy.speed *
    multiplier *
    dt;
  enemy.y += (towardY * radial + towardX * enemy.orbitDirection * orbitWeight) *
    enemy.speed *
    multiplier *
    dt;
}

function chooseWeightedKind(
  weights: Partial<Record<EnemyKind, number>>,
  random: () => number,
) {
  const entries = Object.entries(weights).filter(
    (entry) => (entry[1] ?? 0) > 0,
  ) as [EnemyKind, number][];
  const total = entries.reduce((sum, entry) => sum + entry[1], 0);
  let roll = random() * total;
  for (const [kind, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return kind;
  }
  return entries.at(-1)?.[0] ?? "file";
}

function enemyStats(kind: EnemyKind) {
  if (kind === "media") {
    return { radius: 15, speed: 61, health: 3, points: 28, damage: 1 };
  }
  if (kind === "library") {
    return { radius: 20, speed: 44, health: 6, points: 74, damage: 1 };
  }
  if (kind === "malicious") {
    return { radius: 13, speed: 60, health: 3, points: 58, damage: 1 };
  }
  if (kind === "duplicate") {
    return { radius: 14, speed: 67, health: 3, points: 48, damage: 1 };
  }
  if (kind === "corruptor") {
    return { radius: 16, speed: 50, health: 4, points: 68, damage: 1 };
  }
  if (kind === "buffering") {
    return { radius: 12, speed: 78, health: 2, points: 44, damage: 1 };
  }
  if (kind === "support") {
    return { radius: 15, speed: 54, health: 4, points: 82, damage: 1 };
  }
  return { radius: 11, speed: 82, health: 1, points: 12, damage: 1 };
}

function enemyCost(kind: EnemyKind) {
  if (kind === "library" || kind === "support") return 4;
  if (kind === "corruptor" || kind === "malicious" || kind === "duplicate") {
    return 3;
  }
  if (kind === "media" || kind === "buffering") return 2;
  return 1;
}

function adjustedBudget(state: GameState, budget: number) {
  return Math.round(budget * DIFFICULTIES[state.mode].spawnBudgetMultiplier);
}

function segmentHitsCircle(
  projectile: Projectile,
  circle: Point,
  radius: number,
) {
  const vx = projectile.x - projectile.previousX;
  const vy = projectile.y - projectile.previousY;
  const lengthSquared = vx * vx + vy * vy;
  const projection = lengthSquared === 0 ? 0 : clamp(
    ((circle.x - projectile.previousX) * vx +
      (circle.y - projectile.previousY) * vy) /
      lengthSquared,
    0,
    1,
  );
  const closestX = projectile.previousX + vx * projection;
  const closestY = projectile.previousY + vy * projection;
  return Math.hypot(circle.x - closestX, circle.y - closestY) <= radius;
}

function burstParticles(
  state: GameState,
  x: number,
  y: number,
  color: string,
  count: number,
) {
  const allowed = Math.min(count, MAX_PARTICLES - state.particles.length);
  for (let index = 0; index < allowed; index++) {
    const angle = nextRandom(state) * Math.PI * 2;
    const speed = 40 + nextRandom(state) * 150;
    const life = 0.25 + nextRandom(state) * 0.4;
    state.particles.push({
      id: state.nextParticleId++,
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life,
      maxLife: life,
      color,
      size: 1.5 + nextRandom(state) * 3,
    });
  }
}

function enemyColor(enemy: Enemy) {
  if (enemy.kind === "boss") return "#ffd36e";
  if (enemy.kind === "malicious" || enemy.kind === "corruptor") {
    return "#ff6684";
  }
  if (enemy.kind === "duplicate") return "#b687ff";
  if (enemy.kind === "support") return "#65d6e8";
  if (enemy.kind === "buffering") return "#ffca69";
  if (enemy.kind === "media") return "#a978e8";
  if (enemy.kind === "library") return "#f3a65a";
  return "#ef6f79";
}

function nextRandom(state: GameState) {
  let value = state.rngState >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.rngState = value >>> 0;
  return state.rngState / 0x1_0000_0000;
}

function createSeed() {
  try {
    return crypto.getRandomValues(new Uint32Array(1))[0] || 1;
  } catch {
    return (Date.now() ^ Math.floor(Math.random() * 0xffff_ffff)) >>> 0;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
