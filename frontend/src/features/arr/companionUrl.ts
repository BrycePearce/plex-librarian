import type { ArrInstance } from "../../lib/api";

export function companionUrl(
  instances: readonly ArrInstance[],
  targetType: "radarr" | "sonarr",
): string {
  if (instances.some((instance) => instance.type === targetType)) return "";

  const opposite = instances.filter((instance) => instance.type !== targetType);
  if (opposite.length !== 1) return "";

  try {
    const parsed = new URL(opposite[0].url);
    if (
      parsed.username ||
      parsed.password ||
      !parsed.port ||
      (parsed.pathname !== "/" && parsed.pathname !== "")
    ) {
      return "";
    }

    const sourceType = opposite[0].type;
    if (parsed.hostname.toLowerCase() === sourceType) {
      parsed.hostname = targetType;
    }
    parsed.port = targetType === "radarr" ? "7878" : "8989";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}
