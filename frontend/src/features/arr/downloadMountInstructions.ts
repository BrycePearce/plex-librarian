export type MountPlatform = "unraid" | "compose";

export function validMountFolder(path: string): boolean {
  return path.startsWith("/") && path !== "/" && path === path.trim() &&
    !path.endsWith("/") && !path.includes("\\") && !path.includes("//") &&
    !path.split("/").some((part) => part === "." || part === "..") &&
    ![...path].some((c) => c.charCodeAt(0) < 32);
}

/** Quote YAML scalars and escape Compose interpolation, including literal $. */
export function downloadMountInstructions(
  platform: MountPlatform,
  host: string,
  local: string,
): string | null {
  if (
    !validMountFolder(host) || !validMountFolder(local) || local === "/data" ||
    local.startsWith("/data/")
  ) return null;
  if (platform === "unraid") {
    return `Host Path: ${host}\nContainer Path: ${local}\nAccess Mode: Read/Write`;
  }
  const quote = (value: string) => JSON.stringify(value.replaceAll("$", () => "$$"));
  return `- type: bind\n  source: ${quote(host)}\n  target: ${
    quote(local)
  }\n  read_only: false\n  bind:\n    create_host_path: false`;
}
