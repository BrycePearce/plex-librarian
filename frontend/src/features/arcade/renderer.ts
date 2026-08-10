import { ACTS, UPGRADE_BY_ID } from "./content.ts";
import { getCurrentEncounter } from "./engine.ts";
import type { TouchVisuals } from "./input.ts";
import type { ArcadeSettings, Enemy, GameState, Hazard } from "./types.ts";

interface RenderOptions {
  paused: boolean;
  settings: ArcadeSettings;
  touch: TouchVisuals;
}

export function renderArcade(
  context: CanvasRenderingContext2D,
  state: GameState,
  width: number,
  height: number,
  options: RenderOptions,
) {
  const palette = ACTS[state.actIndex]?.palette ?? ACTS[0].palette;
  context.save();
  context.clearRect(0, 0, width, height);
  if (options.settings.screenShake && !options.settings.reducedEffects && state.screenShake > 0) {
    const strength = state.screenShake * 5;
    context.translate(
      Math.sin(state.elapsed * 81) * strength,
      Math.cos(state.elapsed * 67) * strength,
    );
  }
  drawArena(context, state, width, height);
  drawObjective(context, state, width, height);
  drawSingularity(context, state);
  drawPowerupDrops(context, state);
  drawUpgradeTargets(context, state);
  for (const hazard of state.hazards) drawHazard(context, hazard, palette.danger);
  for (const projectile of state.projectiles) drawProjectile(context, projectile);
  for (const enemy of state.enemies) {
    drawEnemy(context, enemy, state.elapsed, state.activePowerups.freezeFor > 0);
  }
  drawBossDialogue(context, state, width, height);
  drawPlayer(context, state);
  drawDeepScan(context, state, width, height);
  if (!options.settings.reducedEffects) drawParticles(context, state);
  drawTouchSticks(context, options.touch, palette.primary);
  if (options.paused) {
    context.fillStyle = "rgba(3, 8, 14, 0.32)";
    context.fillRect(-10, -10, width + 20, height + 20);
  }
  context.restore();
}

function drawArena(
  context: CanvasRenderingContext2D,
  state: GameState,
  width: number,
  height: number,
) {
  const palette = ACTS[state.actIndex]?.palette ?? ACTS[0].palette;
  context.fillStyle = palette.background;
  context.fillRect(-10, -10, width + 20, height + 20);

  const offset = (state.elapsed * 9) % 36;
  context.strokeStyle = palette.grid;
  context.lineWidth = 1;
  context.beginPath();
  for (let x = -36 + offset; x < width + 36; x += 36) {
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let y = -36 + offset; y < height + 36; y += 36) {
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();

  context.save();
  context.globalAlpha = 0.15;
  context.strokeStyle = palette.secondary;
  context.lineWidth = 2;
  const inset = 22 + Math.sin(state.elapsed * 0.7) * 3;
  context.strokeRect(inset, inset, width - inset * 2, height - inset * 2);
  context.restore();

  const labels = state.actIndex === 0
    ? ["ARCHIVE", "RETENTION", "STALE"]
    : state.actIndex === 1
    ? ["HASH", "COPY", "VERSION"]
    : ["SESSION", "TOKEN", "REVOKE"];
  context.save();
  context.font = "700 10px ui-monospace, monospace";
  context.fillStyle = palette.grid;
  for (let index = 0; index < 3; index++) {
    context.fillText(labels[index], 30 + index * (width / 3), 20 + (index % 2) * 18);
  }
  context.restore();
}

function drawObjective(
  context: CanvasRenderingContext2D,
  state: GameState,
  width: number,
  height: number,
) {
  const encounter = getCurrentEncounter(state);
  if (state.phase !== "encounter" || encounter?.objective !== "relay" || !state.relayCache) return;
  const palette = ACTS[state.actIndex].palette;
  const cache = state.relayCache;
  const ratio = Math.max(0, cache.timeRemaining / cache.duration);
  context.save();
  context.translate(cache.x, cache.y);
  const arrivalScale = cache.arrivalFor > 0 ? 1 + cache.arrivalFor * 1.8 : 1;
  context.scale(arrivalScale, arrivalScale);
  context.fillStyle = colorWithAlpha(palette.primary, 0.18);
  context.strokeStyle = colorWithAlpha(palette.primary, 0.78);
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(-13, -11, 26, 22, 4);
  context.fill();
  context.stroke();
  context.strokeStyle = palette.secondary;
  context.lineWidth = 3;
  context.beginPath();
  context.arc(0, 0, 27, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
  context.stroke();

  // Give relay objectives a familiar destination silhouette in addition to the
  // cache icon and timer. The flag remains legible while enemies and effects
  // overlap the target.
  context.strokeStyle = palette.secondary;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(0, 7);
  context.lineTo(0, -36);
  context.stroke();
  context.fillStyle = palette.secondary;
  context.beginPath();
  context.moveTo(1, -35);
  context.lineTo(21, -29);
  context.lineTo(1, -23);
  context.closePath();
  context.fill();

  context.font = "800 8px ui-monospace, monospace";
  context.textAlign = "center";
  context.textBaseline = "bottom";
  context.fillStyle = palette.secondary;
  context.fillText("RECOVER", 0, -42);
  context.restore();

  const dx = cache.x - state.player.x;
  const dy = cache.y - state.player.y;
  const distance = Math.hypot(dx, dy);
  if (distance > Math.min(width, height) * 0.28) {
    const angle = Math.atan2(dy, dx);
    context.save();
    context.translate(
      clampRender(state.player.x + Math.cos(angle) * 48, 26, width - 26),
      clampRender(state.player.y + Math.sin(angle) * 48, 26, height - 26),
    );
    context.rotate(angle);
    context.fillStyle = palette.secondary;
    context.beginPath();
    context.moveTo(12, 0);
    context.lineTo(-7, -7);
    context.lineTo(-7, 7);
    context.closePath();
    context.fill();
    context.restore();
  }
}

function drawProjectile(
  context: CanvasRenderingContext2D,
  projectile: GameState["projectiles"][number],
) {
  if (projectile.friendly) {
    context.strokeStyle = projectile.reflected
      ? "rgba(112, 223, 242, 0.58)"
      : "rgba(248, 212, 119, 0.42)";
    context.lineWidth = projectile.radius;
    context.beginPath();
    context.moveTo(projectile.previousX, projectile.previousY);
    context.lineTo(projectile.x, projectile.y);
    context.stroke();
    context.fillStyle = projectile.reflected ? "#70dff2" : "#f8d477";
    context.shadowColor = projectile.reflected ? "#70dff2" : "#f8d477";
  } else {
    context.strokeStyle = "rgba(255, 91, 116, 0.48)";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(projectile.previousX, projectile.previousY);
    context.lineTo(projectile.x, projectile.y);
    context.stroke();
    context.fillStyle = "#ff5b74";
    context.shadowColor = "#ff5b74";
  }
  context.shadowBlur = 9;
  context.beginPath();
  context.arc(projectile.x, projectile.y, projectile.radius, 0, Math.PI * 2);
  context.fill();
  context.shadowBlur = 0;
}

function drawPlayer(context: CanvasRenderingContext2D, state: GameState) {
  const { player } = state;
  if (player.invulnerableFor > 0 && Math.floor(player.invulnerableFor * 14) % 2 === 0) return;
  const palette = ACTS[state.actIndex].palette;
  context.save();
  context.translate(player.x, player.y);
  context.rotate(player.angle);
  if (player.dashFor > 0) {
    context.strokeStyle = colorWithAlpha(palette.primary, 0.28);
    context.lineWidth = 8;
    context.beginPath();
    context.moveTo(-35, 0);
    context.lineTo(-8, 0);
    context.stroke();
  }
  context.strokeStyle = palette.primary;
  context.fillStyle = palette.background;
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
  context.lineTo(11, 2);
  context.lineTo(20, 0);
  context.moveTo(0, 9);
  context.lineTo(-7, 17);
  context.moveTo(0, 9);
  context.lineTo(7, 17);
  context.stroke();
  if (player.shield > 0 || state.activePowerups.shieldFor > 0) {
    context.strokeStyle = "#70dff2";
    context.lineWidth = state.activePowerups.shieldFor > 0 ? 3 : 2;
    context.globalAlpha = 0.72 + Math.sin(state.elapsed * 5) * 0.18;
    context.beginPath();
    context.arc(0, 2, 23, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();
}

function drawEnemy(
  context: CanvasRenderingContext2D,
  enemy: Enemy,
  elapsed: number,
  frozen: boolean,
) {
  context.save();
  context.translate(enemy.x, enemy.y);
  context.lineWidth = 2;
  context.lineJoin = "round";
  if (enemy.warningFor > 0) {
    context.fillStyle = `rgba(255, 202, 105, ${0.12 + Math.sin(elapsed * 24) * 0.08})`;
    context.shadowColor = "#ffca69";
    context.shadowBlur = 18;
    context.beginPath();
    context.arc(0, 0, enemy.radius + 9, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  }
  if (enemy.elite) {
    context.strokeStyle = "#f8d477";
    context.lineWidth = 2;
    context.setLineDash([4, 3]);
    context.beginPath();
    context.arc(0, 0, enemy.radius + 6 + Math.sin(elapsed * 6) * 2, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);
  }

  if (enemy.kind === "boss") drawBoss(context, enemy, elapsed);
  else if (enemy.kind === "malicious") drawMalicious(context, enemy);
  else if (enemy.kind === "library") drawLibrary(context, enemy.radius);
  else if (enemy.kind === "media") drawMedia(context, enemy.radius);
  else if (enemy.kind === "duplicate") drawDuplicate(context, enemy.radius);
  else if (enemy.kind === "corruptor") drawCorruptor(context, enemy.radius);
  else if (enemy.kind === "buffering") drawBuffering(context, enemy.radius, enemy.aimAngle);
  else if (enemy.kind === "support") drawSupport(context, enemy.radius, elapsed);
  else drawFile(context, enemy.radius);

  if (frozen) {
    context.fillStyle = "rgba(185, 244, 255, 0.18)";
    context.strokeStyle = "#b9f4ff";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(0, 0, enemy.radius + 4, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }

  if (enemy.maxHealth > 1 && enemy.health < enemy.maxHealth) drawHealthBar(context, enemy);
  context.restore();
}

function drawFile(context: CanvasRenderingContext2D, radius: number) {
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

function drawMedia(context: CanvasRenderingContext2D, radius: number) {
  context.fillStyle = "#a978e8";
  context.strokeStyle = "#d4b7ff";
  context.beginPath();
  context.roundRect(-radius, -radius * 0.72, radius * 2, radius * 1.44, 4);
  context.fill();
  context.stroke();
  context.fillStyle = "rgba(7, 16, 26, 0.78)";
  context.beginPath();
  context.moveTo(-radius * 0.2, -radius * 0.3);
  context.lineTo(radius * 0.38, 0);
  context.lineTo(-radius * 0.2, radius * 0.3);
  context.closePath();
  context.fill();
}

function drawLibrary(context: CanvasRenderingContext2D, radius: number) {
  context.strokeStyle = "#ffd09a";
  for (const [index, color] of ["#f3a65a", "#e8894d", "#d96d45"].entries()) {
    const width = radius * (1.5 + (index % 2) * 0.2);
    const y = (index - 1) * radius * 0.62;
    context.fillStyle = color;
    context.beginPath();
    context.roundRect(-width / 2, y - radius * 0.25, width, radius * 0.5, 3);
    context.fill();
    context.stroke();
  }
}

function drawMalicious(context: CanvasRenderingContext2D, enemy: Enemy) {
  context.save();
  context.rotate(enemy.aimAngle);
  context.strokeStyle = "#ff6684";
  context.fillStyle = "#07101a";
  context.lineWidth = 2.5;
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
  context.moveTo(0, 1);
  context.lineTo(19, 0);
  context.stroke();
  context.fillStyle = "#ff4663";
  context.fillRect(14, -2, 6, 4);
  context.restore();
}

function drawDuplicate(context: CanvasRenderingContext2D, radius: number) {
  for (const offset of [-5, 5]) {
    context.save();
    context.translate(offset, -offset * 0.25);
    context.globalAlpha = offset < 0 ? 0.55 : 0.9;
    context.fillStyle = "#9e74e6";
    context.strokeStyle = "#d8c3ff";
    context.beginPath();
    context.roundRect(-radius * 0.65, -radius * 0.85, radius * 1.3, radius * 1.7, 4);
    context.fill();
    context.stroke();
    context.restore();
  }
  context.fillStyle = "#24133e";
  context.font = `700 ${radius}px ui-monospace, monospace`;
  context.textAlign = "center";
  context.fillText("2×", 2, radius * 0.35);
}

function drawCorruptor(context: CanvasRenderingContext2D, radius: number) {
  context.fillStyle = "#4f172b";
  context.strokeStyle = "#ff6684";
  context.beginPath();
  for (let index = 0; index < 8; index++) {
    const angle = (index / 8) * Math.PI * 2;
    const length = index % 2 === 0 ? radius : radius * 0.62;
    const x = Math.cos(angle) * length;
    const y = Math.sin(angle) * length;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.fill();
  context.stroke();
  context.fillStyle = "#ffca69";
  context.beginPath();
  context.arc(0, 0, 3, 0, Math.PI * 2);
  context.fill();
}

function drawBuffering(
  context: CanvasRenderingContext2D,
  radius: number,
  angle: number,
) {
  context.rotate(angle);
  context.strokeStyle = "#ffca69";
  context.lineWidth = 3;
  for (let index = 0; index < 3; index++) {
    context.globalAlpha = 1 - index * 0.25;
    context.beginPath();
    context.moveTo(radius - index * 7, -radius * 0.72);
    context.lineTo(radius + 8 - index * 7, 0);
    context.lineTo(radius - index * 7, radius * 0.72);
    context.stroke();
  }
}

function drawSupport(
  context: CanvasRenderingContext2D,
  radius: number,
  elapsed: number,
) {
  context.rotate(elapsed * 0.8);
  context.strokeStyle = "#65d6e8";
  context.fillStyle = "#102d38";
  context.lineWidth = 2;
  for (let index = 0; index < 3; index++) {
    context.rotate((Math.PI * 2) / 3);
    context.beginPath();
    context.arc(radius, 0, 5, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.beginPath();
  context.arc(0, 0, radius * 0.55, 0, Math.PI * 2);
  context.fill();
  context.stroke();
}

function drawBoss(context: CanvasRenderingContext2D, enemy: Enemy, elapsed: number) {
  const color = enemy.bossKind === "backlog"
    ? "#f3a65a"
    : enemy.bossKind === "hydra"
    ? "#b687ff"
    : enemy.bossKind === "backfill-daemon"
    ? "#70dff2"
    : "#ff6684";
  context.rotate(elapsed * 0.18 * enemy.orbitDirection);
  context.fillStyle = colorWithAlpha(color, 0.28);
  context.strokeStyle = color;
  context.lineWidth = 4;
  const points = enemy.bossKind === "hydra"
    ? 12
    : enemy.bossKind === "admin"
    ? 6
    : enemy.bossKind === "backfill-daemon"
    ? 10
    : 8;
  context.beginPath();
  for (let index = 0; index < points; index++) {
    const angle = (index / points) * Math.PI * 2;
    const length = index % 2 === 0 ? enemy.radius : enemy.radius * 0.7;
    const x = Math.cos(angle) * length;
    const y = Math.sin(angle) * length;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.fill();
  context.stroke();
  context.rotate(-elapsed * 0.7);
  context.fillStyle = color;
  context.font = "800 17px ui-monospace, monospace";
  context.textAlign = "center";
  context.fillText(enemy.phase === 1 ? "I" : enemy.phase === 2 ? "II" : "III", 0, 6);
}

function drawBossDialogue(
  context: CanvasRenderingContext2D,
  state: GameState,
  width: number,
  height: number,
) {
  const dialogue = state.bossDialogue;
  if (!dialogue || dialogue.life <= 0) return;
  context.save();
  context.font = "700 11px ui-monospace, monospace";
  const lines = wrapText(context, dialogue.text, 260);
  const bubbleWidth = Math.min(
    280,
    Math.max(170, ...lines.map((line) => context.measureText(line).width + 28)),
  );
  const bubbleHeight = 24 + lines.length * 16;
  const x = clampRender(dialogue.x, bubbleWidth / 2 + 12, width - bubbleWidth / 2 - 12);
  const preferAbove = dialogue.y - bubbleHeight - 46 >= 12;
  const y = clampRender(
    preferAbove ? dialogue.y - bubbleHeight - 38 : dialogue.y + 42,
    12,
    height - bubbleHeight - 12,
  );
  const fade = Math.min(1, dialogue.life / 0.3, (dialogue.maxLife - dialogue.life) / 0.18);

  context.globalAlpha = Math.max(0, fade);
  context.fillStyle = "rgba(4, 14, 23, 0.94)";
  context.strokeStyle = "#70dff2";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(x - bubbleWidth / 2, y, bubbleWidth, bubbleHeight, 8);
  context.fill();
  context.stroke();
  context.fillStyle = "#e7ffff";
  context.textAlign = "center";
  context.textBaseline = "top";
  lines.forEach((line, index) => context.fillText(line, x, y + 12 + index * 16));
  context.restore();
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

function drawHealthBar(context: CanvasRenderingContext2D, enemy: Enemy) {
  const width = enemy.radius * 1.8;
  context.fillStyle = "rgba(5, 12, 20, 0.82)";
  context.fillRect(-width / 2, -enemy.radius - 9, width, 4);
  context.fillStyle = enemy.kind === "boss" ? "#ffca69" : "#f8d477";
  context.fillRect(
    -width / 2,
    -enemy.radius - 9,
    width * Math.max(0, enemy.health / enemy.maxHealth),
    4,
  );
}

function drawHazard(
  context: CanvasRenderingContext2D,
  hazard: Hazard,
  dangerColor: string,
) {
  const armed = hazard.armFor === 0;
  context.save();
  context.translate(hazard.x, hazard.y);
  if (hazard.kind === "document-burst") {
    const warningRatio = Math.min(1, hazard.armFor / 0.45);
    context.strokeStyle = armed ? dangerColor : "#ff647c";
    context.fillStyle = armed ? colorWithAlpha(dangerColor, 0.28) : "rgba(255, 100, 124, 0.08)";
    context.lineWidth = armed ? 4 : 2;
    context.setLineDash(armed ? [] : [6, 5]);
    context.beginPath();
    context.arc(0, 0, hazard.radius * (armed ? 1 : 1 - warningRatio * 0.35), 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.setLineDash([]);
    context.rotate(Math.PI / 8);
    context.fillStyle = armed ? "#ff647c" : "rgba(255, 100, 124, 0.62)";
    for (const direction of [-1, 1]) {
      context.fillRect(direction * 8 - 4, -6, 8, 12);
    }
    context.restore();
    return;
  }
  context.strokeStyle = armed ? dangerColor : "#ffca69";
  context.fillStyle = armed ? colorWithAlpha(dangerColor, 0.16) : "rgba(255, 202, 105, 0.08)";
  context.lineWidth = 2;
  context.setLineDash(armed ? [] : [5, 4]);
  context.beginPath();
  context.arc(0, 0, hazard.radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(-7, 0);
  context.lineTo(7, 0);
  context.moveTo(0, -7);
  context.lineTo(0, 7);
  context.stroke();
  context.restore();
}

function drawUpgradeTargets(context: CanvasRenderingContext2D, state: GameState) {
  for (const target of state.upgradeTargets) {
    const upgrade = UPGRADE_BY_ID[target.id];
    const scale = target.entranceFor > 0 ? 0.5 + (0.5 - target.entranceFor) : 1;
    context.save();
    context.translate(target.x, target.y);
    context.scale(Math.max(0.3, scale), Math.max(0.3, scale));
    context.fillStyle = "rgba(8, 20, 30, 0.92)";
    context.strokeStyle = target.entranceFor > 0 ? "rgba(248, 212, 119, 0.35)" : "#f8d477";
    context.lineWidth = 3;
    context.beginPath();
    for (let index = 0; index < 6; index++) {
      const angle = -Math.PI / 2 + index * Math.PI / 3;
      const x = Math.cos(angle) * target.radius;
      const y = Math.sin(angle) * target.radius;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.fill();
    context.stroke();
    context.fillStyle = "#f8d477";
    context.font = "800 10px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText(upgrade.name.toUpperCase(), 0, target.radius + 18);
    context.fillStyle = "rgba(233, 243, 241, 0.72)";
    context.font = "600 9px ui-monospace, monospace";
    context.fillText(upgrade.description, 0, target.radius + 31);
    context.restore();
  }
}

function drawPowerupDrops(context: CanvasRenderingContext2D, state: GameState) {
  for (const drop of state.powerupDrops) {
    const color = drop.kind === "reflect"
      ? "#f8d477"
      : drop.kind === "machine-gun"
      ? "#ff7d8f"
      : drop.kind === "super-shot"
      ? "#ffca69"
      : drop.kind === "shield"
      ? "#65d6e8"
      : drop.kind === "freeze"
      ? "#b9f4ff"
      : drop.kind === "singularity"
      ? "#b687ff"
      : drop.kind === "repair"
      ? "#76e0c1"
      : "#b687ff";
    const glyph = drop.kind === "machine-gun"
      ? "M"
      : drop.kind === "super-shot"
      ? "S"
      : drop.kind === "shield"
      ? "O"
      : drop.kind === "reflect"
      ? "R"
      : drop.kind === "prism"
      ? "P"
      : drop.kind === "freeze"
      ? "F"
      : drop.kind === "singularity"
      ? "V"
      : "+";
    context.save();
    context.translate(drop.x, drop.y);
    context.rotate(state.elapsed * 2.4);
    context.fillStyle = colorWithAlpha(color, 0.22);
    context.strokeStyle = color;
    context.shadowColor = color;
    context.shadowBlur = 14;
    context.lineWidth = 2;
    context.beginPath();
    context.rect(-drop.radius, -drop.radius, drop.radius * 2, drop.radius * 2);
    context.fill();
    context.stroke();
    context.shadowBlur = 0;
    context.rotate(-state.elapsed * 2.4);
    context.fillStyle = color;
    context.font = "900 10px ui-monospace, monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(glyph, 0, 0.5);
    context.restore();
  }
}

function drawSingularity(context: CanvasRenderingContext2D, state: GameState) {
  const singularity = state.singularity;
  if (!singularity) return;
  const ratio = Math.max(0, singularity.life / singularity.duration);
  const pulse = 1 + Math.sin(state.elapsed * 12) * 0.08;
  context.save();
  context.translate(singularity.x, singularity.y);
  context.scale(pulse, pulse);
  context.fillStyle = "#020309";
  context.shadowColor = "#b687ff";
  context.shadowBlur = 24;
  context.beginPath();
  context.arc(0, 0, singularity.radius, 0, Math.PI * 2);
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = "rgba(182, 135, 255, 0.9)";
  context.lineWidth = 3;
  context.beginPath();
  context.ellipse(
    0,
    0,
    singularity.radius * 1.85,
    singularity.radius * 0.62,
    -0.35,
    0,
    Math.PI * 2,
  );
  context.stroke();
  context.strokeStyle = "rgba(112, 223, 242, 0.58)";
  context.lineWidth = 2;
  context.beginPath();
  context.arc(
    0,
    0,
    singularity.radius + 11,
    -Math.PI / 2,
    -Math.PI / 2 + Math.PI * 2 * ratio,
  );
  context.stroke();
  context.restore();
}

function drawDeepScan(
  context: CanvasRenderingContext2D,
  state: GameState,
  width: number,
  height: number,
) {
  if (state.player.beamFlashFor <= 0) return;
  const forked = (state.upgrades["forked-scan"] ?? 0) > 0 || state.activePowerups.prism > 0;
  const angles = forked
    ? [state.player.angle - 0.18, state.player.angle, state.player.angle + 0.18]
    : [state.player.angle];
  const beamWidth = 10 * Math.pow(1.3, state.upgrades["wide-query"] ?? 0);
  const length = Math.hypot(width, height) * 1.4;
  context.save();
  context.globalAlpha = Math.min(1, state.player.beamFlashFor / 0.08);
  for (const angle of angles) {
    context.strokeStyle = "rgba(112, 223, 242, 0.28)";
    context.lineWidth = beamWidth * 2.4;
    context.beginPath();
    context.moveTo(state.player.x, state.player.y);
    context.lineTo(
      state.player.x + Math.cos(angle) * length,
      state.player.y + Math.sin(angle) * length,
    );
    context.stroke();
    context.strokeStyle = "#e7ffff";
    context.lineWidth = Math.max(2, beamWidth * 0.42);
    context.stroke();
  }
  context.restore();
}

function drawParticles(context: CanvasRenderingContext2D, state: GameState) {
  for (const particle of state.particles) {
    context.globalAlpha = Math.max(0, particle.life / particle.maxLife);
    context.fillStyle = particle.color;
    context.fillRect(
      particle.x - particle.size / 2,
      particle.y - particle.size / 2,
      particle.size,
      particle.size,
    );
  }
  context.globalAlpha = 1;
}

function drawTouchSticks(
  context: CanvasRenderingContext2D,
  touch: TouchVisuals,
  color: string,
) {
  for (const stick of [touch.movement, touch.aim]) {
    if (!stick) continue;
    context.save();
    context.strokeStyle = colorWithAlpha(color, 0.48);
    context.fillStyle = colorWithAlpha(color, 0.12);
    context.lineWidth = 2;
    context.beginPath();
    context.arc(stick.origin.x, stick.origin.y, 52, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = colorWithAlpha(color, 0.4);
    context.beginPath();
    context.arc(stick.current.x, stick.current.y, 18, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
}

function colorWithAlpha(color: string, alpha: number) {
  if (color.startsWith("#") && color.length === 7) {
    const red = Number.parseInt(color.slice(1, 3), 16);
    const green = Number.parseInt(color.slice(3, 5), 16);
    const blue = Number.parseInt(color.slice(5, 7), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }
  return color;
}

function clampRender(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}
