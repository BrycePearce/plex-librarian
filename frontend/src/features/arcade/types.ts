export interface Point {
  x: number;
  y: number;
}

export type DifficultyMode = "normal" | "hard";
export type WeaponKind = "blaster" | "rail" | "array";
export type ObjectiveKind = "purge" | "relay" | "survive";
export type GamePhase =
  | "title"
  | "encounter"
  | "reward"
  | "boss"
  | "actComplete"
  | "gameOver"
  | "victory"
  | "endless";
export type EnemyKind =
  | "file"
  | "media"
  | "library"
  | "malicious"
  | "duplicate"
  | "corruptor"
  | "buffering"
  | "support"
  | "boss";
export type BossKind = "backlog" | "hydra" | "admin";
export type UpgradeId =
  | "rapid-index"
  | "packet-size"
  | "dedupe-pass"
  | "parallel-writes"
  | "magazine-extension"
  | "hot-swap"
  | "index-accelerator"
  | "wide-query"
  | "forked-scan"
  | "fast-scan"
  | "io-burst"
  | "checksum"
  | "parity"
  | "snapshot"
  | "self-heal"
  | "combo-cache"
  | "compression"
  | "garbage-collector";
export type TemporaryPowerupKind =
  | "machine-gun"
  | "super-shot"
  | "shield"
  | "reflect"
  | "prism"
  | "repair";
export type TemporaryWeaponKind = "machine-gun" | "super-shot";

export interface TemporaryWeaponState {
  kind: TemporaryWeaponKind;
  ammo: number;
}

export interface ArcadeInput {
  movement: Point;
  aim: Point;
  firing: boolean;
  secondary: boolean;
  reload: boolean;
  dash: boolean;
}

export interface Player extends Point {
  health: number;
  maxHealth: number;
  shield: number;
  angle: number;
  invulnerableFor: number;
  fireCooldown: number;
  ammo: number;
  magazineSize: number;
  reloadFor: number;
  reloadDuration: number;
  secondaryCooldown: number;
  beamFlashFor: number;
  dashCooldown: number;
  dashFor: number;
  dashX: number;
  dashY: number;
}

export interface Enemy extends Point {
  id: number;
  kind: EnemyKind;
  radius: number;
  speed: number;
  health: number;
  maxHealth: number;
  points: number;
  damage: number;
  aimAngle: number;
  behaviorCooldown: number;
  warningFor: number;
  phase: number;
  orbitDirection: number;
  splitGeneration: number;
  dashFor: number;
  dashX: number;
  dashY: number;
  elite: boolean;
  bossKind?: BossKind;
}

export interface Projectile extends Point {
  id: number;
  previousX: number;
  previousY: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  pierce: number;
  life: number;
  friendly: boolean;
  hitIds: number[];
  bouncesRemaining: number;
  reflected: boolean;
}

export interface RelayCache extends Point {
  radius: number;
  timeRemaining: number;
  duration: number;
  arrivalFor: number;
}

export interface UpgradeTarget extends Point {
  id: UpgradeId;
  radius: number;
  entranceFor: number;
}

export interface PowerupDrop extends Point {
  id: number;
  kind: TemporaryPowerupKind;
  radius: number;
  life: number;
}

export interface ActivePowerups {
  reflect: number;
  prism: number;
  shieldFor: number;
  shieldHits: number;
}

export interface Hazard extends Point {
  id: number;
  kind: "mine" | "corruption" | "scanline" | "document-burst";
  radius: number;
  life: number;
  armFor: number;
  damage: number;
}

export interface Particle extends Point {
  id: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

export interface SpawnBeat {
  at: number;
  budget: number;
  weights: Partial<Record<EnemyKind, number>>;
}

export interface EncounterDefinition {
  id: string;
  act: number;
  index: number;
  name: string;
  briefing: string;
  objective: ObjectiveKind;
  target: number;
  duration: number;
  spawnInterval: number;
  openingThreats: number;
  threatFloor: number;
  threatCap: number;
  replenishMin: number;
  replenishMax: number;
  eliteChance: number;
  relayDuration?: number;
  beats: SpawnBeat[];
}

export interface BossDefinition {
  id: string;
  act: number;
  name: string;
  kind: BossKind;
  briefing: string;
  health: number;
  speed: number;
  points: number;
}

export interface DifficultyConfig {
  id: DifficultyMode;
  label: string;
  spawnBudgetMultiplier: number;
  enemySpeedMultiplier: number;
  enemyHealthMultiplier: number;
  projectileSpeedMultiplier: number;
  warningMultiplier: number;
  recoveryHealth: number;
}

export interface UpgradeDefinition {
  id: UpgradeId;
  name: string;
  description: string;
  family: "firepower" | "projectile" | "mobility" | "integrity" | "combo";
  maxLevel: number;
}

export interface WeaponDefinition {
  id: WeaponKind;
  name: string;
  description: string;
}

export interface ActDefinition {
  id: string;
  name: string;
  subtitle: string;
  palette: {
    background: string;
    grid: string;
    primary: string;
    secondary: string;
    danger: string;
  };
  encounters: EncounterDefinition[];
  boss: BossDefinition;
}

export interface GameState {
  width: number;
  height: number;
  seed: number;
  rngState: number;
  mode: DifficultyMode;
  phase: GamePhase;
  actIndex: number;
  encounterIndex: number;
  endlessRound: number;
  weapon: WeaponKind;
  player: Player;
  enemies: Enemy[];
  projectiles: Projectile[];
  hazards: Hazard[];
  particles: Particle[];
  score: number;
  comboCount: number;
  comboMultiplier: number;
  comboTimer: number;
  elapsed: number;
  phaseElapsed: number;
  objectiveProgress: number;
  objectiveTarget: number;
  kills: number;
  noDamage: boolean;
  spawnCooldown: number;
  spawnBeatIndex: number;
  spawnBudgetRemaining: number;
  upgrades: Partial<Record<UpgradeId, number>>;
  offeredUpgrades: UpgradeId[];
  nextEnemyId: number;
  nextProjectileId: number;
  nextHazardId: number;
  nextParticleId: number;
  screenShake: number;
  relayCache: RelayCache | null;
  relayStreak: number;
  relayMisses: number;
  upgradeTargets: UpgradeTarget[];
  rewardRevealFor: number;
  rewardSelectionArmed: boolean;
  rewardTransitionFor: number;
  powerupDrops: PowerupDrop[];
  activePowerups: ActivePowerups;
  temporaryWeapon: TemporaryWeaponState | null;
  nextPowerupId: number;
  dropCooldown: number;
  killsSincePowerupDrop: number;
  powerupsDroppedThisPhase: number;
  lastPowerupKind: TemporaryPowerupKind | null;
  powerupsCollected: number;
  patternCooldown: number;
  patternWarningFor: number;
  patternSourceId: number | null;
  patternKind: "aimed" | "radial" | null;
  banner: string;
  gameOverReason?: string;
}

export type GameAction =
  | { type: "start"; mode: DifficultyMode; weapon: WeaponKind; seed?: number }
  | { type: "chooseUpgrade"; upgradeId: UpgradeId }
  | { type: "continueAct" }
  | { type: "restartAct" }
  | { type: "startEndless" }
  | { type: "returnToTitle" };

export interface ArcadeSettings {
  musicEnabled: boolean;
  sfxEnabled: boolean;
  musicVolume: number;
  sfxVolume: number;
  reducedEffects: boolean;
  screenShake: boolean;
}

export interface ArcadeUnlocks {
  rail: boolean;
  array: boolean;
  hard: boolean;
  endless: boolean;
}

export interface ArcadeCheckpoint {
  seed: number;
  mode: DifficultyMode;
  actIndex: number;
  weapon: WeaponKind;
  score: number;
  upgrades: Partial<Record<UpgradeId, number>>;
  maxHealth: number;
  health: number;
  shield: number;
}

export interface ArcadeSaveV2 {
  version: 2;
  settings: ArcadeSettings;
  unlocks: ArcadeUnlocks;
  bestScores: Record<DifficultyMode, number>;
  victories: Record<DifficultyMode, number>;
  achievements: string[];
  checkpoint: ArcadeCheckpoint | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}
