import { CircleCheck, CircleHelp, CircleX, TriangleAlert } from "lucide-react";
import type { IntegrationCompatibilityCheck } from "@plex-librarian/shared/types.ts";
import { HoverPopover } from "../../components/HoverPopover.tsx";

export function IntegrationCompatibilityIndicator({
  check,
}: {
  check: IntegrationCompatibilityCheck | undefined;
}) {
  if (!check) return null;

  const version = check.version ? ` ${check.version}` : "";
  if (check.status === "compatible") {
    return (
      <HoverPopover content={`${check.name}${version} passed its compatibility check.`}>
        <span
          className="inline-flex items-center text-success"
          tabIndex={0}
          aria-label={`${check.name}${version} is compatible`}
        >
          <CircleCheck className="size-4" />
        </span>
      </HoverPopover>
    );
  }

  const unavailable = check.status === "unreachable";
  const unverified = check.status === "unverified";
  const Icon = unavailable ? CircleX : unverified ? CircleHelp : TriangleAlert;
  return (
    <HoverPopover
      content={
        <div className="space-y-1">
          <strong
            className={unavailable ? "text-error" : unverified ? "text-info" : "text-warning"}
          >
            {unavailable
              ? "Connection unavailable"
              : unverified
              ? "Compatibility not yet verified"
              : "Compatibility warning"}
          </strong>
          {check.version && <div>{check.name} {check.version}</div>}
          <p className="max-w-72 text-base-content/70">{check.message}</p>
        </div>
      }
      openOnClick
    >
      <button
        type="button"
        className={`btn btn-ghost btn-xs btn-square ${
          unavailable ? "text-error" : unverified ? "text-info" : "text-warning"
        }`}
        aria-label={`Show compatibility details for ${check.name}`}
      >
        <Icon className="size-4" />
      </button>
    </HoverPopover>
  );
}
