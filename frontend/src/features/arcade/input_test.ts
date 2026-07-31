import { assertAlmostEquals, assertEquals } from "@std/assert";
import { deadZone, keyboardActionForCode, normalizedStick } from "./input.ts";

Deno.test("touch stick normalizes and caps movement", () => {
  const result = normalizedStick({ x: 10, y: 10 }, { x: 114, y: 10 });
  assertEquals(result, { x: 1, y: 0 });
});

Deno.test("touch stick preserves partial movement", () => {
  const result = normalizedStick({ x: 0, y: 0 }, { x: 13, y: 0 });
  assertAlmostEquals(result.x, 0.25);
  assertEquals(result.y, 0);
});

Deno.test("gamepad dead zone suppresses drift and rescales input", () => {
  assertEquals(deadZone(0.08, -0.06), { x: 0, y: 0 });
  const result = deadZone(0.59, 0);
  assertAlmostEquals(result.x, 0.5);
  assertEquals(result.y, 0);
});

Deno.test("keyboard maps Space to Deep Scan and R to reload", () => {
  assertEquals(keyboardActionForCode("Space"), "secondary");
  assertEquals(keyboardActionForCode("KeyR"), "reload");
  assertEquals(keyboardActionForCode("KeyF"), "primary");
  assertEquals(keyboardActionForCode("ShiftLeft"), "dash");
});
