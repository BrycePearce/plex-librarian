import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Crosshair,
  Heart,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  type ArcadeInput,
  type ArcadeState,
  createArcadeState,
  type Enemy,
  resizeArcadeState,
  stepArcade,
} from "./engine.ts";
import musicUrl from "./assets/oldschool-action-theme.mp3?url";
import "./arcade.css";

interface GameSummary {
  score: number;
  wave: number;
  health: number;
  comboCount: number;
  comboMultiplier: number;
  gameOver: boolean;
}

const INITIAL_SUMMARY: GameSummary = {
  score: 0,
  wave: 1,
  health: 3,
  comboCount: 0,
  comboMultiplier: 1,
  gameOver: false,
};
const HIGH_SCORE_KEY = "plex-librarian:arcade-high-score";
// Keep daisyUI from promoting its full slider component into the shared stylesheet just
// because it sees the native input type as a static source token.
const SLIDER_INPUT_TYPE = ["ra", "nge"].join("") as React.HTMLInputTypeAttribute;

export function ArcadeGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const frameRef = useRef<number | null>(null);
  const stateRef = useRef<ArcadeState | null>(null);
  const keysRef = useRef(new Set<string>());
  const pointerRef = useRef({ x: 0, y: 0, firing: false });
  const pausedRef = useRef(false);
  const musicEnabledRef = useRef(true);
  const volumeRef = useRef(0.28);
  const [paused, setPaused] = useState(false);
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [volume, setVolume] = useState(28);
  const [runId, setRunId] = useState(0);
  const [summary, setSummary] = useState(INITIAL_SUMMARY);
  const [highScore, setHighScore] = useState(readHighScore);

  const restart = useCallback(() => {
    stateRef.current = null;
    pointerRef.current.firing = false;
    pausedRef.current = false;
    setPaused(false);
    setSummary(INITIAL_SUMMARY);
    setRunId((value) => value + 1);
  }, []);

  const togglePause = useCallback(() => {
    if (summary.gameOver) return;
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  }, [summary.gameOver]);

  const startMusic = useCallback(() => {
    const audio = audioRef.current;
    if (
      !audio || !musicEnabledRef.current || pausedRef.current ||
      stateRef.current?.gameOver
    ) return;

    audio.volume = volumeRef.current;
    // Autoplay can be rejected until the first keyboard/pointer interaction. Keep the
    // preference enabled and retry from those interaction handlers below.
    void audio.play().catch(() => undefined);
  }, []);

  const toggleMusic = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (musicEnabledRef.current) {
      audio.pause();
      musicEnabledRef.current = false;
      setMusicEnabled(false);
      return;
    }

    musicEnabledRef.current = true;
    setMusicEnabled(true);
    startMusic();
  }, [startMusic]);

  const changeVolume = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const nextVolume = Number(event.currentTarget.value);
    volumeRef.current = nextVolume / 100;
    setVolume(nextVolume);
    if (audioRef.current) audioRef.current.volume = volumeRef.current;
    startMusic();
  }, [startMusic]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !musicEnabled) return;

    if (paused || summary.gameOver) {
      audio.pause();
    } else {
      startMusic();
    }
  }, [musicEnabled, paused, startMusic, summary.gameOver]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => audio?.pause();
  }, []);

  useEffect(() => {
    if (summary.score <= highScore) return;
    setHighScore(summary.score);
    try {
      localStorage.setItem(HIGH_SCORE_KEY, String(summary.score));
    } catch {
      // A blocked storage API should never stop the game.
    }
  }, [highScore, summary.score]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let cssWidth = 1;
    let cssHeight = 1;
    let lastTime = performance.now();
    let lastSummaryUpdate = 0;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      cssWidth = Math.max(1, bounds.width);
      cssHeight = Math.max(1, bounds.height);
      const scale = Math.min(globalThis.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssWidth * scale);
      canvas.height = Math.round(cssHeight * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      if (!stateRef.current) {
        stateRef.current = createArcadeState(cssWidth, cssHeight);
        pointerRef.current.x = cssWidth * 0.75;
        pointerRef.current.y = cssHeight / 2;
      } else {
        resizeArcadeState(stateRef.current, cssWidth, cssHeight);
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        ["INPUT", "BUTTON", "A"].includes(event.target.tagName)
      ) return;

      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) {
        event.preventDefault();
      }
      if (event.code === "KeyP" || event.code === "Escape") {
        if (!event.repeat) togglePause();
        return;
      }
      if (
        [
          "KeyW",
          "KeyA",
          "KeyS",
          "KeyD",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Space",
        ].includes(event.code)
      ) startMusic();
      keysRef.current.add(event.code);
    };
    const onKeyUp = (event: KeyboardEvent) => keysRef.current.delete(event.code);
    const onBlur = () => {
      keysRef.current.clear();
      pointerRef.current.firing = false;
    };
    globalThis.addEventListener("keydown", onKeyDown);
    globalThis.addEventListener("keyup", onKeyUp);
    globalThis.addEventListener("blur", onBlur);

    const frame = (time: number) => {
      const state = stateRef.current;
      if (!state) return;
      const delta = (time - lastTime) / 1000;
      lastTime = time;

      if (!pausedRef.current) {
        stepArcade(state, readInput(keysRef.current, pointerRef.current), delta);
      }
      drawGame(context, state, cssWidth, cssHeight, pausedRef.current);

      if (time - lastSummaryUpdate > 100 || state.gameOver !== summary.gameOver) {
        lastSummaryUpdate = time;
        setSummary({
          score: state.score,
          wave: state.wave,
          health: state.player.health,
          comboCount: state.comboCount,
          comboMultiplier: state.comboMultiplier,
          gameOver: state.gameOver,
        });
      }
      frameRef.current = requestAnimationFrame(frame);
    };
    frameRef.current = requestAnimationFrame(frame);

    return () => {
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      globalThis.removeEventListener("keydown", onKeyDown);
      globalThis.removeEventListener("keyup", onKeyUp);
      globalThis.removeEventListener("blur", onBlur);
      keysRef.current.clear();
    };
  }, [runId, startMusic, summary.gameOver, togglePause]);

  const updatePointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    pointerRef.current.x = event.clientX - bounds.left;
    pointerRef.current.y = event.clientY - bounds.top;
  };

  return (
    <section className="arcade-page flex flex-1 flex-col gap-4" aria-labelledby="arcade-title">
      <audio ref={audioRef} src={musicUrl} loop preload="none" />
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-base-content/60">
            <Crosshair className="size-4" /> Classified shelf maintenance
          </div>
          <h1 id="arcade-title" className="text-2xl font-bold">Stale Content Cleanup</h1>
        </div>
        <Link to="/dashboard" className="btn btn-ghost btn-sm gap-2">
          <ArrowLeft className="size-4" /> Back to work
        </Link>
      </header>

      <div className="arcade-hud" aria-live="polite">
        <span>
          <strong>{summary.score}</strong> reclaimed
        </span>
        <span>
          Best <strong>{highScore}</strong>
        </span>
        <span className={`arcade-combo ${summary.comboMultiplier > 1 ? "is-active" : ""}`}>
          {summary.comboCount > 1 ? `${summary.comboCount} chain` : "Combo"}{" "}
          <strong>x{summary.comboMultiplier}</strong>
        </span>
        <span>
          Wave <strong>{summary.wave}</strong>
        </span>
        <span className="arcade-health" aria-label={`${summary.health} health remaining`}>
          {Array.from(
            { length: 3 },
            (_, index) => <Heart key={index} className={index < summary.health ? "is-full" : ""} />,
          )}
        </span>
      </div>

      <div className="arcade-cabinet">
        <canvas
          ref={canvasRef}
          className="arcade-canvas"
          aria-label="Stale Content Cleanup game area"
          onContextMenu={(event) => event.preventDefault()}
          onPointerMove={updatePointer}
          onPointerDown={(event) => {
            updatePointer(event);
            startMusic();
            pointerRef.current.firing = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={() => (pointerRef.current.firing = false)}
          onPointerCancel={() => (pointerRef.current.firing = false)}
        />

        {(paused || summary.gameOver) && (
          <div className="arcade-overlay">
            <div className="arcade-overlay-card">
              <h2>{summary.gameOver ? "Library overrun" : "Paused"}</h2>
              <p>
                {summary.gameOver
                  ? `${summary.score} GB reclaimed. Best: ${highScore} GB.`
                  : "The stale files will wait. Probably."}
              </p>
              <button
                type="button"
                className="btn btn-primary btn-sm gap-2"
                onClick={summary.gameOver ? restart : togglePause}
              >
                {summary.gameOver
                  ? (
                    <>
                      <RotateCcw className="size-4" /> Try again
                    </>
                  )
                  : (
                    <>
                      <Play className="size-4" /> Resume
                    </>
                  )}
              </button>
            </div>
          </div>
        )}
      </div>

      <footer className="arcade-controls">
        <span>
          <kbd>WASD</kbd> or arrows to move
        </span>
        <span>Mouse/touch to aim and fire</span>
        <span className="flex items-center gap-1">
          <button type="button" className="btn btn-ghost btn-xs gap-1" onClick={toggleMusic}>
            {musicEnabled ? <Volume2 className="size-3" /> : <VolumeX className="size-3" />}
            Music {musicEnabled ? "on" : "off"}
          </button>
          <label className="arcade-volume" title={`Music volume: ${volume}%`}>
            <span className="sr-only">Music volume</span>
            <input
              type={SLIDER_INPUT_TYPE}
              min="0"
              max="100"
              step="1"
              value={volume}
              className="arcade-volume-input"
              aria-label="Music volume"
              onChange={changeVolume}
              disabled={!musicEnabled}
            />
          </label>
          <button type="button" className="btn btn-ghost btn-xs gap-1" onClick={togglePause}>
            {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
            {paused ? "Resume" : "Pause"}
          </button>
        </span>
      </footer>
    </section>
  );
}

function readInput(
  keys: Set<string>,
  pointer: { x: number; y: number; firing: boolean },
): ArcadeInput {
  return {
    movement: {
      x: Number(keys.has("KeyD") || keys.has("ArrowRight")) -
        Number(keys.has("KeyA") || keys.has("ArrowLeft")),
      y: Number(keys.has("KeyS") || keys.has("ArrowDown")) -
        Number(keys.has("KeyW") || keys.has("ArrowUp")),
    },
    aim: pointer,
    firing: pointer.firing || keys.has("Space"),
  };
}

function drawGame(
  context: CanvasRenderingContext2D,
  state: ArcadeState,
  width: number,
  height: number,
  paused: boolean,
) {
  context.clearRect(0, 0, width, height);
  drawGrid(context, width, height);

  for (const projectile of state.projectiles) {
    context.beginPath();
    context.fillStyle = "#f8d477";
    context.shadowColor = "#f8d477";
    context.shadowBlur = 10;
    context.arc(projectile.x, projectile.y, 3, 0, Math.PI * 2);
    context.fill();
  }
  context.shadowBlur = 0;

  for (const projectile of state.enemyProjectiles) {
    const speed = Math.hypot(projectile.vx, projectile.vy) || 1;
    context.strokeStyle = "rgba(255, 91, 116, 0.55)";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(projectile.x, projectile.y);
    context.lineTo(
      projectile.x - (projectile.vx / speed) * 10,
      projectile.y - (projectile.vy / speed) * 10,
    );
    context.stroke();
    context.fillStyle = "#ff5b74";
    context.shadowColor = "#ff5b74";
    context.shadowBlur = 9;
    context.beginPath();
    context.arc(projectile.x, projectile.y, 4, 0, Math.PI * 2);
    context.fill();
  }
  context.shadowBlur = 0;

  for (const enemy of state.enemies) drawEnemy(context, enemy);
  drawPlayer(context, state);

  if (paused) {
    context.fillStyle = "rgba(7, 12, 20, 0.2)";
    context.fillRect(0, 0, width, height);
  }
}

function drawGrid(context: CanvasRenderingContext2D, width: number, height: number) {
  context.fillStyle = "#07101a";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(104, 211, 181, 0.08)";
  context.lineWidth = 1;
  context.beginPath();
  for (let x = 0; x < width; x += 32) {
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let y = 0; y < height; y += 32) {
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();
}

function drawPlayer(context: CanvasRenderingContext2D, state: ArcadeState) {
  const { player } = state;
  if (player.invulnerableFor > 0 && Math.floor(player.invulnerableFor * 12) % 2 === 0) return;

  context.save();
  context.translate(player.x, player.y);
  context.rotate(player.angle);
  context.strokeStyle = "#68d3b5";
  context.fillStyle = "#07101a";
  context.lineWidth = 3;
  context.lineCap = "round";
  context.beginPath();
  context.arc(0, -9, 5, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.beginPath();
  context.moveTo(0, -3);
  context.lineTo(0, 9);
  context.moveTo(0, 1);
  context.lineTo(10, 2);
  context.lineTo(19, 0);
  context.moveTo(0, 9);
  context.lineTo(-7, 17);
  context.moveTo(0, 9);
  context.lineTo(7, 17);
  context.stroke();
  context.restore();
}

function drawEnemy(context: CanvasRenderingContext2D, enemy: Enemy) {
  const { x, y, radius } = enemy;
  context.save();
  context.translate(x, y);
  context.lineWidth = 2;
  context.lineJoin = "round";

  if (enemy.kind === "malicious") drawMaliciousEnemy(context, enemy);
  else if (enemy.kind === "library") drawLibraryEnemy(context, radius);
  else if (enemy.kind === "media") drawMediaEnemy(context, radius);
  else drawFileEnemy(context, radius);

  if (enemy.maxHealth > 1 && enemy.health < enemy.maxHealth) {
    const width = radius * 1.7;
    context.fillStyle = "rgba(5, 12, 20, 0.8)";
    context.fillRect(-width / 2, -radius - 7, width, 3);
    context.fillStyle = "#f8d477";
    context.fillRect(-width / 2, -radius - 7, width * (enemy.health / enemy.maxHealth), 3);
  }
  context.restore();
}

function drawMaliciousEnemy(context: CanvasRenderingContext2D, enemy: Enemy) {
  const telegraphing = (enemy.shootCooldown ?? 1) < 0.35;
  if (telegraphing) {
    context.fillStyle = "rgba(255, 70, 99, 0.2)";
    context.shadowColor = "#ff4663";
    context.shadowBlur = 18;
    context.beginPath();
    context.arc(0, 0, enemy.radius + 7, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  }

  context.save();
  context.rotate(enemy.aimAngle ?? 0);
  context.strokeStyle = telegraphing ? "#ff4663" : "#f36b81";
  context.fillStyle = "#07101a";
  context.lineWidth = 2.5;
  context.lineCap = "round";
  context.beginPath();
  context.arc(0, -8, 4.5, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.beginPath();
  context.moveTo(0, -3);
  context.lineTo(0, 9);
  context.moveTo(0, 9);
  context.lineTo(-7, 16);
  context.moveTo(0, 9);
  context.lineTo(7, 16);
  context.stroke();

  context.save();
  context.rotate(Math.sin(enemy.spinPhase ?? 0) * 0.22);
  context.beginPath();
  context.moveTo(0, 1);
  context.lineTo(10, 0);
  context.lineTo(17, 0);
  context.stroke();
  context.fillStyle = "#ff4663";
  context.fillRect(14, -2, 6, 4);
  context.restore();
  context.restore();
}

function drawFileEnemy(context: CanvasRenderingContext2D, radius: number) {
  context.fillStyle = "#ef6f79";
  context.strokeStyle = "#ffadb4";
  context.beginPath();
  context.moveTo(-radius * 0.68, -radius);
  context.lineTo(radius * 0.25, -radius);
  context.lineTo(radius * 0.68, -radius * 0.55);
  context.lineTo(radius * 0.68, radius);
  context.lineTo(-radius * 0.68, radius);
  context.closePath();
  context.fill();
  context.stroke();
  context.strokeStyle = "rgba(7, 16, 26, 0.78)";
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(-radius * 0.38, radius * 0.15);
  context.lineTo(radius * 0.38, radius * 0.15);
  context.moveTo(-radius * 0.38, radius * 0.48);
  context.lineTo(radius * 0.2, radius * 0.48);
  context.stroke();
}

function drawMediaEnemy(context: CanvasRenderingContext2D, radius: number) {
  context.fillStyle = "#a978e8";
  context.strokeStyle = "#d4b7ff";
  context.beginPath();
  context.roundRect(-radius, -radius * 0.72, radius * 2, radius * 1.44, 4);
  context.fill();
  context.stroke();
  context.fillStyle = "rgba(7, 16, 26, 0.78)";
  for (const side of [-1, 1]) {
    for (const offset of [-0.42, 0, 0.42]) {
      context.fillRect(side * radius * 0.78 - 1.5, offset * radius - 1.5, 3, 3);
    }
  }
  context.beginPath();
  context.moveTo(-radius * 0.2, -radius * 0.3);
  context.lineTo(radius * 0.38, 0);
  context.lineTo(-radius * 0.2, radius * 0.3);
  context.closePath();
  context.fill();
}

function drawLibraryEnemy(context: CanvasRenderingContext2D, radius: number) {
  const books = [
    { y: -0.68, width: 1.5, color: "#f3a65a" },
    { y: -0.05, width: 1.75, color: "#e8894d" },
    { y: 0.58, width: 1.38, color: "#d96d45" },
  ];
  context.strokeStyle = "#ffd09a";
  for (const book of books) {
    const width = radius * book.width;
    const height = radius * 0.52;
    context.fillStyle = book.color;
    context.beginPath();
    context.roundRect(-width / 2, radius * book.y - height / 2, width, height, 3);
    context.fill();
    context.stroke();
    context.fillStyle = "rgba(7, 16, 26, 0.64)";
    context.fillRect(-width * 0.3, radius * book.y - 1, width * 0.6, 2);
  }
}

function readHighScore() {
  try {
    const stored = Number(localStorage.getItem(HIGH_SCORE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : 0;
  } catch {
    return 0;
  }
}
