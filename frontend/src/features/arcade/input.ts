/// <reference lib="dom" />

import type { ArcadeInput, Player, Point } from "./types.ts";

export interface TouchStickVisual {
  origin: Point;
  current: Point;
}

export interface TouchVisuals {
  movement?: TouchStickVisual;
  aim?: TouchStickVisual;
}

interface InputControllerOptions {
  onInteract: () => void;
  onPause: () => void;
  onBlur: () => void;
}

export class ArcadeInputController {
  private readonly keys = new Set<string>();
  private readonly canvas: HTMLCanvasElement;
  private readonly options: InputControllerOptions;
  private mouse = { x: 0, y: 0, firing: false };
  private movementTouch: (TouchStickVisual & { pointerId: number }) | null = null;
  private aimTouch: (TouchStickVisual & { pointerId: number }) | null = null;
  private dashQueued = false;
  private secondaryQueued = false;
  private reloadQueued = false;
  private gamepadDashPressed = false;
  private gamepadSecondaryPressed = false;
  private gamepadReloadPressed = false;
  private gamepadPausePressed = false;
  private hadGamepad = false;

  constructor(canvas: HTMLCanvasElement, options: InputControllerOptions) {
    this.canvas = canvas;
    this.options = options;
    this.mouse.x = canvas.clientWidth * 0.75;
    this.mouse.y = canvas.clientHeight / 2;
    globalThis.addEventListener("keydown", this.onKeyDown);
    globalThis.addEventListener("keyup", this.onKeyUp);
    globalThis.addEventListener("blur", this.onBlur);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("contextmenu", this.onContextMenu);
  }

  read(player: Player): ArcadeInput {
    const keyboardMovement = {
      x: Number(this.keys.has("KeyD") || this.keys.has("ArrowRight")) -
        Number(this.keys.has("KeyA") || this.keys.has("ArrowLeft")),
      y: Number(this.keys.has("KeyS") || this.keys.has("ArrowDown")) -
        Number(this.keys.has("KeyW") || this.keys.has("ArrowUp")),
    };
    const touchMovement = this.movementTouch
      ? normalizedStick(this.movementTouch.origin, this.movementTouch.current)
      : null;
    const gamepad = this.readGamepad(player);
    const movement = gamepad?.movement ??
      touchMovement ??
      keyboardMovement;

    let aim = this.mouse;
    if (this.aimTouch) {
      const direction = normalizedStick(this.aimTouch.origin, this.aimTouch.current);
      if (Math.hypot(direction.x, direction.y) > 0.08) {
        aim = { x: player.x + direction.x * 160, y: player.y + direction.y * 160, firing: true };
      }
    }
    if (gamepad?.aim) aim = { ...gamepad.aim, firing: gamepad.firing };

    const input = {
      movement,
      aim: { x: aim.x, y: aim.y },
      firing: this.mouse.firing || this.keys.has("KeyF") || Boolean(this.aimTouch) ||
        Boolean(gamepad?.firing),
      secondary: this.secondaryQueued || Boolean(gamepad?.secondary),
      reload: this.reloadQueued || Boolean(gamepad?.reload),
      dash: this.dashQueued || Boolean(gamepad?.dash),
    };
    this.dashQueued = false;
    this.secondaryQueued = false;
    this.reloadQueued = false;
    return input;
  }

  queueDash() {
    this.dashQueued = true;
    this.options.onInteract();
  }

  queueSecondary() {
    this.secondaryQueued = true;
    this.options.onInteract();
  }

  getTouchVisuals(): TouchVisuals {
    return {
      movement: this.movementTouch
        ? { origin: this.movementTouch.origin, current: this.movementTouch.current }
        : undefined,
      aim: this.aimTouch
        ? { origin: this.aimTouch.origin, current: this.aimTouch.current }
        : undefined,
    };
  }

  clear() {
    this.keys.clear();
    this.mouse.firing = false;
    this.movementTouch = null;
    this.aimTouch = null;
    this.dashQueued = false;
    this.secondaryQueued = false;
    this.reloadQueued = false;
  }

  destroy() {
    this.clear();
    globalThis.removeEventListener("keydown", this.onKeyDown);
    globalThis.removeEventListener("keyup", this.onKeyUp);
    globalThis.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (
      event.target instanceof HTMLElement &&
      ["INPUT", "BUTTON", "A", "SELECT"].includes(event.target.tagName)
    ) return;

    if (
      [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Space",
        "ShiftLeft",
        "ShiftRight",
      ].includes(event.code)
    ) {
      event.preventDefault();
    }
    const action = keyboardActionForCode(event.code);
    if (action === "pause") {
      if (!event.repeat) this.options.onPause();
      return;
    }
    if (!event.repeat && action === "dash") this.dashQueued = true;
    if (!event.repeat && action === "secondary") this.secondaryQueued = true;
    if (!event.repeat && action === "reload") this.reloadQueued = true;
    this.keys.add(event.code);
    this.options.onInteract();
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = () => {
    this.clear();
    this.options.onBlur();
  };

  private readonly onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    this.dashQueued = true;
    this.options.onInteract();
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    const point = canvasPoint(this.canvas, event);
    this.options.onInteract();
    this.canvas.setPointerCapture(event.pointerId);
    if (event.pointerType === "touch") {
      const stick = { pointerId: event.pointerId, origin: point, current: point };
      if (point.x < this.canvas.clientWidth / 2 && !this.movementTouch) {
        this.movementTouch = stick;
      } else if (!this.aimTouch) {
        this.aimTouch = stick;
      }
      return;
    }
    this.mouse = { ...point, firing: event.button === 0 };
    if (event.button === 2) this.dashQueued = true;
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const point = canvasPoint(this.canvas, event);
    if (event.pointerType === "touch") {
      const movementTouch = this.movementTouch;
      const aimTouch = this.aimTouch;
      if (movementTouch?.pointerId === event.pointerId) {
        movementTouch.current = limitedPoint(movementTouch.origin, point);
      }
      if (aimTouch?.pointerId === event.pointerId) {
        aimTouch.current = limitedPoint(aimTouch.origin, point);
      }
      return;
    }
    this.mouse.x = point.x;
    this.mouse.y = point.y;
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.movementTouch?.pointerId === event.pointerId) this.movementTouch = null;
    if (this.aimTouch?.pointerId === event.pointerId) this.aimTouch = null;
    if (event.pointerType !== "touch") this.mouse.firing = false;
  };

  private readGamepad(player: Player) {
    let pads: (Gamepad | null)[] = [];
    try {
      pads = Array.from(navigator.getGamepads?.() ?? []);
    } catch {
      return null;
    }
    const pad = pads.find((candidate) => candidate?.connected) ?? null;
    if (!pad) {
      if (this.hadGamepad) {
        this.hadGamepad = false;
        this.options.onBlur();
      }
      return null;
    }
    this.hadGamepad = true;

    const movement = deadZone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    const aimDirection = deadZone(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
    const hasAim = Math.hypot(aimDirection.x, aimDirection.y) > 0.08;
    const dashPressed = Boolean(pad.buttons[4]?.pressed || pad.buttons[0]?.pressed);
    const pausePressed = Boolean(pad.buttons[9]?.pressed);
    const secondaryPressed = Boolean(pad.buttons[6]?.pressed);
    const reloadPressed = Boolean(pad.buttons[2]?.pressed);
    const dash = dashPressed && !this.gamepadDashPressed;
    const secondary = secondaryPressed && !this.gamepadSecondaryPressed && hasAim;
    const reload = reloadPressed && !this.gamepadReloadPressed;
    if (pausePressed && !this.gamepadPausePressed) this.options.onPause();
    this.gamepadDashPressed = dashPressed;
    this.gamepadSecondaryPressed = secondaryPressed;
    this.gamepadReloadPressed = reloadPressed;
    this.gamepadPausePressed = pausePressed;
    const firing = Boolean(pad.buttons[7]?.pressed || pad.buttons[5]?.pressed) && hasAim;
    return {
      movement,
      aim: hasAim
        ? { x: player.x + aimDirection.x * 180, y: player.y + aimDirection.y * 180 }
        : null,
      firing,
      secondary,
      reload,
      dash,
    };
  }
}

export function normalizedStick(origin: Point, current: Point) {
  const dx = current.x - origin.x;
  const dy = current.y - origin.y;
  const distance = Math.hypot(dx, dy);
  const magnitude = Math.min(1, distance / 52);
  return distance > 0
    ? { x: (dx / distance) * magnitude, y: (dy / distance) * magnitude }
    : { x: 0, y: 0 };
}

export function deadZone(x: number, y: number, threshold = 0.18) {
  const distance = Math.hypot(x, y);
  if (distance <= threshold) return { x: 0, y: 0 };
  const magnitude = Math.min(1, (distance - threshold) / (1 - threshold));
  return { x: (x / distance) * magnitude, y: (y / distance) * magnitude };
}

export function keyboardActionForCode(code: string) {
  if (code === "KeyP" || code === "Escape") return "pause" as const;
  if (code === "ShiftLeft" || code === "ShiftRight") return "dash" as const;
  if (code === "Space") return "secondary" as const;
  if (code === "KeyR") return "reload" as const;
  if (code === "KeyF") return "primary" as const;
  return null;
}

function canvasPoint(canvas: HTMLCanvasElement, event: PointerEvent) {
  const bounds = canvas.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function limitedPoint(origin: Point, current: Point) {
  const dx = current.x - origin.x;
  const dy = current.y - origin.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= 52) return current;
  return { x: origin.x + (dx / distance) * 52, y: origin.y + (dy / distance) * 52 };
}
