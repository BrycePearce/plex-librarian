import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Crosshair,
  Gauge,
  Heart,
  Pause,
  Play,
  RotateCcw,
  Shield,
  Trophy,
  Volume2,
  VolumeX,
  Zap,
} from "lucide-react";
import { ACTS, DIFFICULTIES, WEAPONS } from "./content.ts";
import {
  createGameState,
  createStateFromCheckpoint,
  dispatchGameAction,
  getActProgress,
  getCurrentEncounter,
  getObjectiveLabel,
  resizeGameState,
  stepGame,
} from "./engine.ts";
import { ArcadeInputController } from "./input.ts";
import { ArcadeAudio } from "./audio.ts";
import { ARCADE_OPENING_TRACK_URL, claimArcadeLaunchMusic } from "../../lib/arcadeLaunch.ts";
import {
  checkpointFromState,
  createDefaultSave,
  readArcadeSave,
  recordScore,
  writeArcadeSave,
} from "./persistence.ts";
import { renderArcade } from "./renderer.ts";
import type {
  ArcadeSaveV2,
  ArcadeSettings,
  DifficultyMode,
  GamePhase,
  GameState,
  WeaponKind,
} from "./types.ts";
import backlogBossMusicUrl from "./assets/backlog-boss.mp3?url";
import duplicateBossMusicUrl from "./assets/duplicate-boss.ogg?url";
import duplicateMusicUrl from "./assets/duplicate-vault.mp3?url";
import rogueMusicUrl from "./assets/rogue-access.mp3?url";
import rogueBossMusicUrl from "./assets/rogue-boss.mp3?url";
import "./arcade.css";

interface GameSummary {
  phase: GamePhase;
  actIndex: number;
  encounterIndex: number;
  endlessRound: number;
  score: number;
  health: number;
  maxHealth: number;
  shield: number;
  comboCount: number;
  comboMultiplier: number;
  dashCooldown: number;
  ammo: number;
  magazineSize: number;
  magazineLabel: string;
  reloadFor: number;
  secondaryCooldown: number;
  powerups: Array<{ label: string; remaining: number }>;
  objective: string;
  actProgress: number;
  banner: string;
  weapon: WeaponKind;
  mode: DifficultyMode;
  noDamage: boolean;
  gameOverReason?: string;
}

const INITIAL_SUMMARY: GameSummary = {
  phase: "title",
  actIndex: 0,
  encounterIndex: 0,
  endlessRound: 0,
  score: 0,
  health: 3,
  maxHealth: 3,
  shield: 0,
  comboCount: 0,
  comboMultiplier: 1,
  dashCooldown: 0,
  ammo: 14,
  magazineSize: 14,
  magazineLabel: "Magazine",
  reloadFor: 0,
  secondaryCooldown: 0,
  powerups: [],
  objective: "",
  actProgress: 0,
  banner: "",
  weapon: "blaster",
  mode: "normal",
  noDamage: true,
};
const ACTIVE_PHASES = new Set<GamePhase>(["encounter", "reward", "boss", "endless"]);
const SLIDER_INPUT_TYPE = ["ra", "nge"].join("") as React.HTMLInputTypeAttribute;

export function ArcadeGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const musicElementARef = useRef<HTMLAudioElement>(null);
  const musicElementBRef = useRef<HTMLAudioElement>(null);
  const stateRef = useRef<GameState | null>(null);
  const inputRef = useRef<ArcadeInputController | null>(null);
  const audioRef = useRef<ArcadeAudio | null>(null);
  const frameRef = useRef<number | null>(null);
  const pausedRef = useRef(false);
  const settingsRef = useRef<ArcadeSettings>(createDefaultSave().settings);
  const saveRef = useRef<ArcadeSaveV2 | null>(null);
  const previousSignalsRef = useRef({
    phase: "title" as GamePhase,
    health: 3,
    score: 0,
    projectileId: 1,
    dashCooldown: 0,
    warningCount: 0,
    secondaryCooldown: 0,
    reloadFor: 0,
    powerupCount: 0,
    powerupsCollected: 0,
    endlessRound: 0,
    upgradeTargetCount: 0,
  });
  const [save, setSave] = useState<ArcadeSaveV2>(readArcadeSave);
  const [summary, setSummary] = useState<GameSummary>(INITIAL_SUMMARY);
  const [paused, setPaused] = useState(false);
  const [selectedMode, setSelectedMode] = useState<DifficultyMode>("normal");
  const [selectedWeapon, setSelectedWeapon] = useState<WeaponKind>("blaster");
  const [showSettings, setShowSettings] = useState(false);
  const [runId, setRunId] = useState(0);
  settingsRef.current = save.settings;
  saveRef.current = save;

  const commitSave = useCallback((update: (draft: ArcadeSaveV2) => void) => {
    setSave((current) => {
      const next = structuredClone(current);
      update(next);
      writeArcadeSave(next);
      return next;
    });
  }, []);

  const setPauseState = useCallback((next: boolean) => {
    pausedRef.current = next;
    setPaused(next);
    if (next) audioRef.current?.pause();
    else audioRef.current?.resume();
  }, []);

  const togglePause = useCallback(() => {
    const state = stateRef.current;
    if (!state || !ACTIVE_PHASES.has(state.phase)) return;
    setPauseState(!pausedRef.current);
  }, [setPauseState]);

  const beginAudio = useCallback(() => {
    const state = stateRef.current;
    if (!state || state.phase === "title") return;
    audioRef.current?.startFor(state.actIndex, state.phase, state.endlessRound);
  }, []);

  const beginOpeningAudio = useCallback(() => {
    const state = stateRef.current;
    if (!state || state.phase === "title") return;
    audioRef.current?.startOpeningFor(state.actIndex, state.phase, state.endlessRound);
  }, []);

  const handleBlur = useCallback(() => {
    const state = stateRef.current;
    if (state && ACTIVE_PHASES.has(state.phase) && !pausedRef.current) setPauseState(true);
  }, [setPauseState]);

  const handleTransition = useCallback((state: GameState, previous: GamePhase) => {
    if (state.phase === previous) return;
    if (ACTIVE_PHASES.has(state.phase) && !pausedRef.current) {
      audioRef.current?.startFor(state.actIndex, state.phase, state.endlessRound);
    }
    if (state.phase === "reward") audioRef.current?.playSfx("reward");
    if (state.phase === "boss") audioRef.current?.playSfx("boss");

    if (state.phase === "actComplete") {
      commitSave((draft) => {
        recordScore(draft, state.mode, state.score);
        if (state.actIndex === 0) {
          draft.unlocks.rail = true;
          if (!draft.achievements.includes("Backlog cleared")) {
            draft.achievements.push("Backlog cleared");
          }
        }
        if (state.actIndex < ACTS.length - 1) {
          draft.checkpoint = {
            ...checkpointFromState(state),
            actIndex: state.actIndex + 1,
            health: Math.min(state.player.maxHealth, state.player.health + 1),
          };
        }
      });
    } else if (state.phase === "gameOver") {
      commitSave((draft) => recordScore(draft, state.mode, state.score));
      audioRef.current?.pause();
    } else if (state.phase === "victory") {
      commitSave((draft) => {
        recordScore(draft, state.mode, state.score);
        draft.victories[state.mode] += 1;
        draft.unlocks.array = true;
        draft.unlocks.endless = true;
        if (state.mode === "normal") draft.unlocks.hard = true;
        draft.checkpoint = null;
        if (!draft.achievements.includes("Library secured")) {
          draft.achievements.push("Library secured");
        }
      });
      audioRef.current?.playSfx("reward");
    }
  }, [commitSave]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const musicElementA = musicElementARef.current;
    const musicElementB = musicElementBRef.current;
    if (!canvas || !musicElementA || !musicElementB) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const launchMusic = claimArcadeLaunchMusic();
    const audio = new ArcadeAudio(
      [launchMusic ?? musicElementA, musicElementB],
      {
        stale: ARCADE_OPENING_TRACK_URL,
        "backlog-boss": backlogBossMusicUrl,
        duplicate: duplicateMusicUrl,
        "duplicate-boss": duplicateBossMusicUrl,
        rogue: rogueMusicUrl,
        "rogue-boss": rogueBossMusicUrl,
      },
      settingsRef.current,
      launchMusic ? "stale" : null,
    );
    audioRef.current = audio;
    let cssWidth = 1;
    let cssHeight = 1;
    let previousTime = performance.now();
    let accumulator = 0;
    let lastSummaryAt = 0;
    let lastSummaryPhase: GamePhase = stateRef.current?.phase ?? "title";
    let adoptingLaunchMusic = launchMusic !== null;
    const fixedStep = 1 / 60;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      cssWidth = Math.max(1, bounds.width);
      cssHeight = Math.max(1, bounds.height);
      const scale = Math.min(globalThis.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssWidth * scale);
      canvas.height = Math.round(cssHeight * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      if (!stateRef.current) {
        const currentSave = saveRef.current ?? createDefaultSave();
        if (currentSave.victories.normal === 0 && currentSave.checkpoint) {
          stateRef.current = createStateFromCheckpoint(cssWidth, cssHeight, currentSave.checkpoint);
        } else {
          stateRef.current = createGameState(cssWidth, cssHeight);
          if (currentSave.victories.normal === 0) {
            dispatchGameAction(stateRef.current, {
              type: "start",
              mode: "normal",
              weapon: "blaster",
            });
            commitSave((draft) => {
              draft.checkpoint = checkpointFromState(stateRef.current!);
            });
          }
        }
        setSummary(summarize(stateRef.current));
      } else {
        resizeGameState(stateRef.current, cssWidth, cssHeight);
      }
      if (ACTIVE_PHASES.has(stateRef.current.phase)) {
        if (adoptingLaunchMusic) {
          adoptingLaunchMusic = false;
          audio.startOpeningFor(
            stateRef.current.actIndex,
            stateRef.current.phase,
            stateRef.current.endlessRound,
          );
        } else {
          audio.startFor(
            stateRef.current.actIndex,
            stateRef.current.phase,
            stateRef.current.endlessRound,
          );
        }
      }
    };

    const input = new ArcadeInputController(canvas, {
      onInteract: beginAudio,
      onPause: togglePause,
      onBlur: handleBlur,
    });
    inputRef.current = input;
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const frame = (time: number) => {
      const state = stateRef.current;
      if (!state) return;
      const elapsed = Math.min(0.25, Math.max(0, (time - previousTime) / 1000));
      previousTime = time;

      if (!pausedRef.current && ACTIVE_PHASES.has(state.phase)) {
        accumulator = Math.min(accumulator + elapsed, fixedStep * 6);
        while (accumulator >= fixedStep) {
          stepGame(state, input.read(state.player), fixedStep);
          accumulator -= fixedStep;
        }
      } else {
        accumulator = 0;
      }

      renderArcade(context, state, cssWidth, cssHeight, {
        paused: pausedRef.current,
        settings: settingsRef.current,
        touch: input.getTouchVisuals(),
      });

      const previousSignals = previousSignalsRef.current;
      handleTransition(state, previousSignals.phase);
      if (state.phase === "endless" && state.endlessRound !== previousSignals.endlessRound) {
        audio.startFor(state.actIndex, state.phase, state.endlessRound);
      }
      if (state.player.health < previousSignals.health) audio.playSfx("damage");
      if (state.score > previousSignals.score) audio.playSfx("hit");
      if (state.nextProjectileId > previousSignals.projectileId) audio.playSfx("fire");
      if (state.player.dashCooldown > previousSignals.dashCooldown + 0.5) audio.playSfx("dash");
      if (state.player.secondaryCooldown > previousSignals.secondaryCooldown + 4) {
        audio.playSfx("beam");
      }
      if (state.player.reloadFor > previousSignals.reloadFor + 0.4) audio.playSfx("reload");
      const powerupCount = Number(state.activePowerups.reflect > 0) +
        Number(state.activePowerups.prism > 0) +
        Number(state.activePowerups.shieldFor > 0) +
        Number(state.temporaryWeapon !== null);
      if (state.powerupsCollected > previousSignals.powerupsCollected) audio.playSfx("powerup");
      if (
        previousSignals.upgradeTargetCount > 0 && state.upgradeTargets.length === 0 &&
        state.phase === "reward"
      ) audio.playSfx("select");
      const warningCount = state.enemies.filter((enemy) => enemy.warningFor > 0).length +
        state.hazards.filter((hazard) => hazard.armFor > 0).length;
      if (warningCount > previousSignals.warningCount) audio.playSfx("warning");
      previousSignalsRef.current = {
        phase: state.phase,
        health: state.player.health,
        score: state.score,
        projectileId: state.nextProjectileId,
        dashCooldown: state.player.dashCooldown,
        warningCount,
        secondaryCooldown: state.player.secondaryCooldown,
        reloadFor: state.player.reloadFor,
        powerupCount,
        powerupsCollected: state.powerupsCollected,
        endlessRound: state.endlessRound,
        upgradeTargetCount: state.upgradeTargets.length,
      };

      if (time - lastSummaryAt >= 100 || state.phase !== lastSummaryPhase) {
        lastSummaryAt = time;
        lastSummaryPhase = state.phase;
        setSummary(summarize(state));
      }
      frameRef.current = requestAnimationFrame(frame);
    };
    frameRef.current = requestAnimationFrame(frame);

    const onVisibilityChange = () => {
      if (document.hidden) handleBlur();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      input.destroy();
      audio.destroy();
      inputRef.current = null;
      audioRef.current = null;
    };
  }, [beginAudio, commitSave, handleBlur, handleTransition, runId, togglePause]);

  useEffect(() => {
    audioRef.current?.applySettings(save.settings);
  }, [save.settings]);

  const startRun = (mode: DifficultyMode, weapon: WeaponKind) => {
    const state = stateRef.current;
    if (!state) return;
    dispatchGameAction(state, { type: "start", mode, weapon });
    previousSignalsRef.current = {
      phase: state.phase,
      health: state.player.health,
      score: state.score,
      projectileId: state.nextProjectileId,
      dashCooldown: 0,
      warningCount: 0,
      secondaryCooldown: 0,
      reloadFor: 0,
      powerupCount: 0,
      powerupsCollected: state.powerupsCollected,
      endlessRound: state.endlessRound,
      upgradeTargetCount: 0,
    };
    commitSave((draft) => {
      draft.checkpoint = checkpointFromState(state);
    });
    setPauseState(false);
    setSummary(summarize(state));
    beginOpeningAudio();
  };

  const resumeRun = () => {
    const checkpoint = save.checkpoint;
    const canvas = canvasRef.current;
    if (!checkpoint || !canvas) return;
    stateRef.current = createStateFromCheckpoint(
      Math.max(1, canvas.clientWidth),
      Math.max(1, canvas.clientHeight),
      checkpoint,
    );
    previousSignalsRef.current = {
      phase: stateRef.current.phase,
      health: stateRef.current.player.health,
      score: stateRef.current.score,
      projectileId: stateRef.current.nextProjectileId,
      dashCooldown: 0,
      warningCount: 0,
      secondaryCooldown: 0,
      reloadFor: 0,
      powerupCount: 0,
      powerupsCollected: stateRef.current.powerupsCollected,
      endlessRound: stateRef.current.endlessRound,
      upgradeTargetCount: 0,
    };
    setPauseState(false);
    setSummary(summarize(stateRef.current));
    beginOpeningAudio();
  };

  const continueAct = () => {
    const state = stateRef.current;
    if (!state) return;
    dispatchGameAction(state, { type: "continueAct" });
    if (state.phase === "encounter") {
      commitSave((draft) => {
        draft.checkpoint = checkpointFromState(state);
      });
    }
    setSummary(summarize(state));
    beginAudio();
  };

  const restartAct = () => {
    const checkpoint = save.checkpoint;
    const canvas = canvasRef.current;
    if (!checkpoint || !canvas) {
      setRunId((value) => value + 1);
      return;
    }
    stateRef.current = createStateFromCheckpoint(
      Math.max(1, canvas.clientWidth),
      Math.max(1, canvas.clientHeight),
      checkpoint,
    );
    setPauseState(false);
    setSummary(summarize(stateRef.current));
    beginOpeningAudio();
  };

  const returnToTitle = () => {
    const state = stateRef.current;
    if (!state) return;
    if (save.victories.normal === 0) {
      restartAct();
      return;
    }
    dispatchGameAction(state, { type: "returnToTitle" });
    audioRef.current?.pause();
    setPauseState(false);
    setSummary(summarize(state));
  };

  const startEndless = () => {
    const state = stateRef.current;
    if (!state) return;
    dispatchGameAction(state, { type: "startEndless" });
    setPauseState(false);
    setSummary(summarize(state));
    beginOpeningAudio();
  };

  const changeSettings = (patch: Partial<ArcadeSettings>) => {
    commitSave((draft) => Object.assign(draft.settings, patch));
  };

  const bestScore = Math.max(save.bestScores[summary.mode], summary.score);
  const act = ACTS[summary.actIndex] ?? ACTS[0];
  const encounter = getCurrentEncounter(stateRef.current ?? createGameState(1, 1));
  const active = ACTIVE_PHASES.has(summary.phase);
  const weapon = WEAPONS.find((candidate) => candidate.id === summary.weapon) ?? WEAPONS[0];
  const overlay = (() => {
    if (summary.phase === "title") {
      return (
        <TitleScreen
          save={save}
          mode={selectedMode}
          weapon={selectedWeapon}
          onMode={setSelectedMode}
          onWeapon={setSelectedWeapon}
          onStart={() => startRun(selectedMode, selectedWeapon)}
          onResume={resumeRun}
          onSettings={() => setShowSettings((value) => !value)}
          showSettings={showSettings}
          onChangeSettings={changeSettings}
        />
      );
    }
    if (summary.phase === "actComplete") {
      const isFinal = summary.actIndex === ACTS.length - 1;
      return (
        <ResultScreen
          icon={<Check />}
          eyebrow="Act secured"
          title={summary.banner}
          copy={isFinal
            ? "Every library is clean. One final report remains."
            : `${ACTS[summary.actIndex + 1].name} is now cleared for entry.`}
          score={summary.score}
          primary={isFinal ? "Complete archive" : "Enter next act"}
          onPrimary={continueAct}
          onSecondary={save.victories.normal > 0 ? returnToTitle : undefined}
        />
      );
    }
    if (summary.phase === "gameOver") {
      return (
        <ResultScreen
          icon={<RotateCcw />}
          eyebrow="Recovery checkpoint available"
          title="Library overrun"
          copy={summary.gameOverReason ?? "The cleanup job failed safely."}
          score={summary.score}
          primary="Restart this act"
          onPrimary={restartAct}
          onSecondary={save.victories.normal > 0 ? returnToTitle : undefined}
        />
      );
    }
    if (summary.phase === "victory") {
      return (
        <ResultScreen
          icon={<Trophy />}
          eyebrow={`${DIFFICULTIES[summary.mode].label} complete`}
          title="Library secured"
          copy="The Quarantine Array, Hard mode, and endless maintenance are now available."
          score={summary.score}
          primary="Start endless mode"
          onPrimary={startEndless}
          onSecondary={returnToTitle}
        />
      );
    }
    if (paused) {
      return (
        <PauseScreen
          onResume={togglePause}
          onRestart={restartAct}
          onTitle={save.victories.normal > 0 ? returnToTitle : undefined}
          settings={save.settings}
          onChangeSettings={changeSettings}
        />
      );
    }
    return null;
  })();

  return (
    <section className="arcade-page flex flex-1 flex-col gap-3" aria-labelledby="arcade-title">
      <audio ref={musicElementARef} loop preload="none" />
      <audio ref={musicElementBRef} loop preload="none" />
      <header className="arcade-heading">
        <div>
          <div className="arcade-kicker">
            <Crosshair className="size-4" /> Classified shelf maintenance
          </div>
          <h1 id="arcade-title">Stale Content Cleanup</h1>
        </div>
        <Link to="/dashboard" className="btn btn-ghost btn-sm gap-2">
          <ArrowLeft className="size-4" /> Back to work
        </Link>
      </header>

      <div className="arcade-hud" aria-live="polite">
        <div className="arcade-hud-stat">
          <small>Reclaimed</small>
          <strong>{summary.score.toLocaleString()} GB</strong>
        </div>
        <div className="arcade-hud-stat">
          <small>Best · {DIFFICULTIES[summary.mode].label}</small>
          <strong>{bestScore.toLocaleString()}</strong>
        </div>
        <div
          className={`arcade-hud-stat arcade-combo ${
            summary.comboMultiplier > 1 ? "is-active" : ""
          }`}
        >
          <small>{summary.comboCount > 1 ? `${summary.comboCount} deletion chain` : "Combo"}</small>
          <strong>×{summary.comboMultiplier}</strong>
        </div>
        <div className="arcade-hud-stat arcade-objective">
          <small>
            {summary.phase === "endless"
              ? "Endless"
              : `Act ${summary.actIndex + 1} · ${
                summary.phase === "boss" ? "Boss" : `Job ${summary.encounterIndex + 1}`
              }`}
          </small>
          <strong>{summary.objective || summary.banner || "Awaiting assignment"}</strong>
          <span>
            <i style={{ width: `${summary.actProgress * 100}%` }} />
          </span>
        </div>
        <div className="arcade-vitals">
          <span className="arcade-health" aria-label={`${summary.health} integrity remaining`}>
            {Array.from(
              { length: summary.maxHealth },
              (_, index) => (
                <Heart key={index} className={index < summary.health ? "is-full" : ""} />
              ),
            )}
          </span>
          {summary.shield > 0 && (
            <span className="arcade-shield" title="Snapshot shield">
              <Shield /> {summary.shield}
            </span>
          )}
          {summary.powerups.length > 0 && (
            <span className="arcade-powerups">
              {summary.powerups.map((powerup) => (
                <i key={powerup.label}>
                  {powerup.label}
                  {powerup.remaining >= 0 ? ` ${Math.ceil(powerup.remaining)}s` : ""}
                </i>
              ))}
            </span>
          )}
        </div>
      </div>

      <div className={`arcade-cabinet arcade-act-${summary.actIndex + 1}`}>
        <canvas
          ref={canvasRef}
          className="arcade-canvas"
          aria-label="Stale Content Cleanup game area"
        />
        {active && !paused && (
          <>
            <div className="arcade-mission-chip">
              <span>
                {summary.phase === "reward"
                  ? "Select maintenance patch"
                  : summary.phase === "boss"
                  ? act.boss.name
                  : encounter?.name}
              </span>
              <small>
                {summary.phase === "reward"
                  ? "Shoot one patch to install it and continue."
                  : summary.phase === "boss"
                  ? act.boss.briefing
                  : encounter?.briefing}
              </small>
            </div>
            <div className="arcade-combat-indicators">
              <div
                className={`arcade-magazine-indicator ${
                  summary.reloadFor > 0 ? "is-reloading" : ""
                }`}
              >
                <span>
                  <small>{summary.reloadFor > 0 ? "Reloading" : summary.magazineLabel}</small>
                  <strong>
                    {summary.reloadFor > 0
                      ? `${summary.reloadFor.toFixed(1)}s`
                      : `${summary.ammo}/${summary.magazineSize}`}
                  </strong>
                </span>
              </div>
              <div
                className={`arcade-secondary-indicator ${
                  summary.secondaryCooldown === 0 ? "is-ready" : ""
                }`}
              >
                <kbd>Space</kbd>
                <span>
                  <small>Deep Scan</small>
                  <strong>
                    {summary.secondaryCooldown === 0
                      ? "Ready"
                      : `${summary.secondaryCooldown.toFixed(1)}s`}
                  </strong>
                </span>
              </div>
            </div>
            <button
              type="button"
              className="arcade-touch-secondary"
              onPointerDown={(event) => {
                event.preventDefault();
                inputRef.current?.queueSecondary();
              }}
              aria-label="Deep Scan Beam"
            >
              <Crosshair />
            </button>
            <button
              type="button"
              className="arcade-touch-dash"
              onPointerDown={(event) => {
                event.preventDefault();
                inputRef.current?.queueDash();
              }}
              aria-label="Dash"
            >
              <Zap />
            </button>
          </>
        )}
        {overlay && <div className="arcade-overlay">{overlay}</div>}
      </div>

      <footer className="arcade-controls">
        <span>
          <kbd>WASD</kbd> Move
        </span>
        <span>
          <kbd>Mouse</kbd> Aim / fire
        </span>
        <span>
          <kbd>Space</kbd> Deep Scan
        </span>
        <span>
          <kbd>R</kbd> Reload
        </span>
        <span>
          <kbd>Shift</kbd> Dash
        </span>
        <span className="arcade-loadout">
          <Gauge /> {weapon.name}
        </span>
        <span className="arcade-footer-actions">
          <button
            type="button"
            className="btn btn-ghost btn-xs gap-1"
            onClick={() => changeSettings({ musicEnabled: !save.settings.musicEnabled })}
          >
            {save.settings.musicEnabled
              ? <Volume2 className="size-3" />
              : <VolumeX className="size-3" />}
            Music
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs gap-1"
            onClick={togglePause}
            disabled={!active}
          >
            {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
            {paused ? "Resume" : "Pause"}
          </button>
        </span>
      </footer>
    </section>
  );
}

function TitleScreen({
  save,
  mode,
  weapon,
  onMode,
  onWeapon,
  onStart,
  onResume,
  onSettings,
  showSettings,
  onChangeSettings,
}: {
  save: ArcadeSaveV2;
  mode: DifficultyMode;
  weapon: WeaponKind;
  onMode: (mode: DifficultyMode) => void;
  onWeapon: (weapon: WeaponKind) => void;
  onStart: () => void;
  onResume: () => void;
  onSettings: () => void;
  showSettings: boolean;
  onChangeSettings: (patch: Partial<ArcadeSettings>) => void;
}) {
  return (
    <div className="arcade-overlay-card arcade-title-card">
      <div className="arcade-card-icon">
        <Crosshair />
      </div>
      <div className="arcade-overlay-eyebrow">Incident response briefing</div>
      <h2>Three libraries. One cleanup window.</h2>
      <p>
        Clear nine authored jobs, choose a build between sectors, and survive each library’s
        resident catastrophe.
      </p>

      {save.checkpoint && (
        <button type="button" className="arcade-resume" onClick={onResume}>
          <span>
            <small>Checkpoint available</small>
            <strong>Resume {ACTS[save.checkpoint.actIndex].name}</strong>
          </span>
          <ChevronRight />
        </button>
      )}

      <div className="arcade-setup-grid">
        <fieldset>
          <legend>Difficulty</legend>
          {(["normal", "hard"] as DifficultyMode[]).map((candidate) => {
            const locked = candidate === "hard" && !save.unlocks.hard;
            return (
              <button
                key={candidate}
                type="button"
                className={mode === candidate ? "is-selected" : ""}
                onClick={() => !locked && onMode(candidate)}
                disabled={locked}
              >
                <strong>{DIFFICULTIES[candidate].label}</strong>
                <small>
                  {locked
                    ? "Win Normal to unlock"
                    : candidate === "normal"
                    ? "Learnable pressure"
                    : "Hostile patterns"}
                </small>
              </button>
            );
          })}
        </fieldset>
        <fieldset>
          <legend>Cleanup tool</legend>
          {WEAPONS.map((candidate) => {
            const locked = candidate.id === "rail"
              ? !save.unlocks.rail
              : candidate.id === "array"
              ? !save.unlocks.array
              : false;
            return (
              <button
                key={candidate.id}
                type="button"
                className={weapon === candidate.id ? "is-selected" : ""}
                onClick={() => !locked && onWeapon(candidate.id)}
                disabled={locked}
                title={candidate.description}
              >
                <strong>{candidate.name}</strong>
                <small>{locked ? "Locked" : candidate.description}</small>
              </button>
            );
          })}
        </fieldset>
      </div>

      {showSettings && <SettingsPanel settings={save.settings} onChange={onChangeSettings} />}
      <div className="arcade-card-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onSettings}>
          {showSettings ? "Hide settings" : "Audio & effects"}
        </button>
        <button type="button" className="btn btn-primary gap-2" onClick={onStart}>
          <Play className="size-4" /> Start cleanup
        </button>
      </div>
    </div>
  );
}

function ResultScreen({
  icon,
  eyebrow,
  title,
  copy,
  score,
  primary,
  onPrimary,
  onSecondary,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  copy: string;
  score: number;
  primary: string;
  onPrimary: () => void;
  onSecondary?: () => void;
}) {
  return (
    <div className="arcade-overlay-card arcade-result-card">
      <div className="arcade-card-icon">{icon}</div>
      <div className="arcade-overlay-eyebrow">{eyebrow}</div>
      <h2>{title}</h2>
      <p>{copy}</p>
      <div className="arcade-result-score">
        <small>Total reclaimed</small>
        <strong>{score.toLocaleString()} GB</strong>
      </div>
      <div className="arcade-card-actions">
        {onSecondary && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSecondary}>
            Main menu
          </button>
        )}
        <button type="button" className="btn btn-primary btn-sm gap-2" onClick={onPrimary}>
          {primary} <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}

function PauseScreen({
  onResume,
  onRestart,
  onTitle,
  settings,
  onChangeSettings,
}: {
  onResume: () => void;
  onRestart: () => void;
  onTitle?: () => void;
  settings: ArcadeSettings;
  onChangeSettings: (patch: Partial<ArcadeSettings>) => void;
}) {
  return (
    <div className="arcade-overlay-card arcade-pause-card">
      <div className="arcade-card-icon">
        <Pause />
      </div>
      <div className="arcade-overlay-eyebrow">Cleanup suspended</div>
      <h2>Paused</h2>
      <SettingsPanel settings={settings} onChange={onChangeSettings} />
      <div className="arcade-card-actions">
        {onTitle && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onTitle}>
            Main menu
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRestart}>
          Restart act
        </button>
        <button type="button" className="btn btn-primary btn-sm gap-2" onClick={onResume}>
          <Play className="size-4" /> Resume
        </button>
      </div>
    </div>
  );
}

function SettingsPanel({
  settings,
  onChange,
}: {
  settings: ArcadeSettings;
  onChange: (patch: Partial<ArcadeSettings>) => void;
}) {
  return (
    <div className="arcade-settings">
      <label>
        <span>Music</span>
        <input
          type="checkbox"
          checked={settings.musicEnabled}
          onChange={(event) => onChange({ musicEnabled: event.currentTarget.checked })}
        />
        <input
          type={SLIDER_INPUT_TYPE}
          min="0"
          max="100"
          value={settings.musicVolume}
          disabled={!settings.musicEnabled}
          aria-label="Music volume"
          onChange={(event) => onChange({ musicVolume: Number(event.currentTarget.value) })}
        />
      </label>
      <label>
        <span>Effects</span>
        <input
          type="checkbox"
          checked={settings.sfxEnabled}
          onChange={(event) => onChange({ sfxEnabled: event.currentTarget.checked })}
        />
        <input
          type={SLIDER_INPUT_TYPE}
          min="0"
          max="100"
          value={settings.sfxVolume}
          disabled={!settings.sfxEnabled}
          aria-label="Sound effects volume"
          onChange={(event) => onChange({ sfxVolume: Number(event.currentTarget.value) })}
        />
      </label>
      <label className="arcade-setting-toggle">
        <span>Reduced effects</span>
        <input
          type="checkbox"
          checked={settings.reducedEffects}
          onChange={(event) => onChange({ reducedEffects: event.currentTarget.checked })}
        />
      </label>
      <label className="arcade-setting-toggle">
        <span>Screen shake</span>
        <input
          type="checkbox"
          checked={settings.screenShake}
          disabled={settings.reducedEffects}
          onChange={(event) => onChange({ screenShake: event.currentTarget.checked })}
        />
      </label>
    </div>
  );
}

function summarize(state: GameState): GameSummary {
  return {
    phase: state.phase,
    actIndex: state.actIndex,
    encounterIndex: state.encounterIndex,
    endlessRound: state.endlessRound,
    score: state.score,
    health: state.player.health,
    maxHealth: state.player.maxHealth,
    shield: state.player.shield,
    comboCount: state.comboCount,
    comboMultiplier: state.comboMultiplier,
    dashCooldown: state.player.dashCooldown,
    ammo: state.temporaryWeapon?.ammo ?? state.player.ammo,
    magazineSize: state.temporaryWeapon?.kind === "machine-gun"
      ? 48
      : state.temporaryWeapon?.kind === "super-shot"
      ? 6
      : state.player.magazineSize,
    magazineLabel: state.temporaryWeapon?.kind === "machine-gun"
      ? "Machine Gun"
      : state.temporaryWeapon?.kind === "super-shot"
      ? "Super Shot"
      : "Magazine",
    reloadFor: state.player.reloadFor,
    secondaryCooldown: state.player.secondaryCooldown,
    powerups: [
      state.activePowerups.reflect > 0 ? { label: "Reflect", remaining: -1 } : null,
      state.activePowerups.prism > 0 ? { label: "Prism", remaining: -1 } : null,
      state.activePowerups.shieldFor > 0
        ? {
          label: "Shield",
          remaining: -1,
        }
        : null,
    ].filter((powerup): powerup is { label: string; remaining: number } => powerup !== null),
    objective: getObjectiveLabel(state),
    actProgress: getActProgress(state),
    banner: state.banner,
    weapon: state.weapon,
    mode: state.mode,
    noDamage: state.noDamage,
    gameOverReason: state.gameOverReason,
  };
}
