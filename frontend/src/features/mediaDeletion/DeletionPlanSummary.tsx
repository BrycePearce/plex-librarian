import type { ReactNode } from "react";
import { AlertTriangle, Folder, X } from "lucide-react";
import type { ArrCleanupTarget } from "@shared/types";
import { HoverPopover } from "../../components/HoverPopover.tsx";
import { ServiceIcon } from "../../components/ServiceIcons.tsx";
import type { ServiceIconName } from "../../components/ServiceIcons.tsx";
import { formatKilobytes } from "../../lib/format.ts";
import { InfoTip } from "./InfoTip.tsx";

export interface DeletionDestinationOption {
  id: "arr" | "arr-path-override" | "arr-break-glass" | "cleanup";
  service?: ServiceIconName;
  label: string;
  info: string;
  checked: boolean;
  disabled: boolean;
  warning: boolean;
  onChange: (checked: boolean) => void;
}

function DestinationOption({
  service,
  label,
  info,
  checked,
  disabled,
  warning,
  onChange,
}: {
  service?: ServiceIconName;
  label: string;
  info: string;
  checked: boolean;
  disabled: boolean;
  warning: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`inline-flex items-center gap-1.5 text-sm text-base-content/75 transition-colors ${
        disabled ? warning ? "opacity-80" : "opacity-45" : "cursor-pointer"
      }`}
    >
      <input
        type="checkbox"
        className="checkbox checkbox-sm mr-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {service
        ? <ServiceIcon service={service} className="size-4 shrink-0" />
        : <Folder className="size-4 shrink-0" />}
      <span className="whitespace-nowrap font-medium">{label}</span>
      <InfoTip text={info} />
    </label>
  );
}

export function DestinationOptions({
  options,
}: {
  options: DeletionDestinationOption[];
}) {
  if (options.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center justify-end gap-x-5 gap-y-2">
      {options.map((option) => (
        <DestinationOption
          key={option.id}
          service={option.service}
          label={option.label}
          info={option.info}
          checked={option.checked}
          disabled={option.disabled}
          warning={option.warning}
          onChange={option.onChange}
        />
      ))}
    </div>
  );
}

export interface ArrDeletionImpact {
  key: string;
  title: string;
  path?: string | null;
  fileCount?: number | null;
  sizeBytes?: number | null;
}

export function arrCleanupTargetImpact(target: ArrCleanupTarget): ArrDeletionImpact {
  if (target.type === "sonarr") {
    const seasons = target.seasons ?? [];
    const counts = seasons.map((season) => season.episodeFileCount);
    const sizes = seasons.map((season) => season.size);
    return {
      key: `${target.instanceName}:${target.path ?? target.title}`,
      title: target.title,
      path: target.path,
      fileCount: seasons.length > 0 && counts.every((count) => count !== null)
        ? counts.reduce((total, count) => total + count!, 0)
        : null,
      sizeBytes: seasons.length > 0 && sizes.every((size) => size !== null)
        ? sizes.reduce((total, size) => total + size!, 0)
        : null,
    };
  }
  const completeFiles = target.mediaFiles !== null && target.extraFiles !== null;
  const sizes = target.mediaFiles?.map((file) => file.size) ?? [];
  return {
    key: `${target.instanceName}:${target.path ?? target.title}`,
    title: target.title,
    path: target.path,
    fileCount: completeFiles ? target.mediaFiles!.length + target.extraFiles!.length : null,
    sizeBytes: completeFiles && target.extraFiles!.length === 0 &&
        sizes.every((size) => size !== null)
      ? sizes.reduce((total, size) => total + size!, 0)
      : null,
  };
}

export function ArrDeletionWarning({
  service,
  impacts,
}: {
  service: "sonarr" | "radarr";
  impacts: ArrDeletionImpact[];
}) {
  if (impacts.length === 0) return null;
  const label = service === "sonarr" ? "Sonarr" : "Radarr";
  const uniqueImpacts = [...new Map(impacts.map((impact) => [impact.key, impact])).values()];
  const counts = uniqueImpacts.map((impact) => impact.fileCount);
  const sizes = uniqueImpacts.map((impact) => impact.sizeBytes);
  const fileCount = counts.every((count) => count !== null && count !== undefined)
    ? counts.reduce((total, count) => total + count!, 0)
    : null;
  const sizeBytes = sizes.every((size) => size !== null && size !== undefined)
    ? sizes.reduce((total, size) => total + size!, 0)
    : null;

  return (
    <div className="alert alert-error mt-3 items-start text-sm" role="alert">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <div className="font-semibold">
          {label} will permanently delete the managed files below
        </div>
        <div className="mt-1 space-y-1 text-error-content/85">
          {uniqueImpacts.map((impact) => (
            <div key={impact.key}>
              <span>{impact.title}</span>
              {impact.path && <span className="break-all font-semibold">— {impact.path}</span>}
            </div>
          ))}
        </div>
        {fileCount !== null && fileCount > 0 && (
          <div className="mt-1 font-semibold text-error-content">
            {fileCount} managed file{fileCount === 1 ? "" : "s"}
            {sizeBytes !== null && sizeBytes > 0
              ? ` totaling ${formatKilobytes(sizeBytes / 1000)}`
              : ""}
          </div>
        )}
        <div className="mt-1 text-xs text-error-content/75">
          Plex Librarian cannot undo this {label} action.
        </div>
      </div>
    </div>
  );
}

function ServiceMark({
  service,
  ariaLabel,
  popover,
  className,
  unavailable = false,
}: {
  service: ServiceIconName;
  ariaLabel: string;
  popover: ReactNode;
  className: string;
  unavailable?: boolean;
}) {
  return (
    <HoverPopover content={popover}>
      <span
        className={`relative inline-flex size-5 cursor-help items-center justify-center rounded p-0.5 leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${className}`}
        tabIndex={0}
        role="img"
        aria-label={ariaLabel}
      >
        <ServiceIcon service={service} className="size-3.5" />
        {unavailable && (
          <span className="absolute -right-1 -top-1 flex size-3 items-center justify-center rounded-full bg-error text-error-content ring-1 ring-base-200">
            <X className="size-2.5" strokeWidth={3} />
          </span>
        )}
      </span>
    </HoverPopover>
  );
}

export function PlannedServiceExceptions({
  deleteFromArr,
  arrService,
  arrStatus,
  arrReason,
  downloadJobCount,
  hardlinkFileCount,
  downloadCleanupResuming,
  cleanupDownloads,
  cleanupStatus,
  cleanupReason,
}: {
  deleteFromArr: boolean;
  arrService: "radarr" | "sonarr";
  arrStatus?: "resolved" | "unavailable" | "error";
  arrReason?: string;
  downloadJobCount: number;
  hardlinkFileCount: number;
  downloadCleanupResuming: boolean;
  cleanupDownloads: boolean;
  cleanupStatus?: "resolved" | "unavailable" | "error";
  cleanupReason?: string;
}) {
  const arrUnavailable = deleteFromArr && arrStatus !== undefined &&
    arrStatus !== "resolved";
  const cleanupAvailable = downloadJobCount > 0 || hardlinkFileCount > 0 ||
    downloadCleanupResuming;
  const cleanupUnavailable = cleanupDownloads && !cleanupAvailable;

  if (!arrUnavailable && !cleanupUnavailable) return null;

  return (
    <span className="flex shrink-0 items-center gap-1">
      {deleteFromArr && arrUnavailable && (
        <ServiceMark
          service={arrService}
          ariaLabel={`Arr deletion unavailable: ${arrReason ?? "no verified match"}`}
          popover={
            <>
              <div className="font-semibold text-error">Arr unavailable</div>
              <div className="mt-1 text-base-content/60">
                {arrReason ??
                  "No verified Sonarr or Radarr match is available."}
              </div>
              <div className="mt-1 text-base-content/45">
                This item will be deleted from Plex only and may be downloaded again if it remains
                monitored.
              </div>
            </>
          }
          className="bg-base-300/70 text-base-content/35"
          unavailable
        />
      )}
      {cleanupUnavailable && (
        <ServiceMark
          service="qbittorrent"
          ariaLabel={`Downloaded-file cleanup unavailable: ${cleanupReason ?? "no verified files"}`}
          popover={
            <>
              <div className="font-semibold text-error">
                Download cleanup unavailable
              </div>
              <div className="mt-1 text-base-content/60">
                {cleanupReason ??
                  (cleanupStatus === "error"
                    ? "Cleanup verification failed."
                    : "No verified download job or hardlink was found.")}
              </div>
            </>
          }
          className="bg-base-300/70 text-base-content/35"
          unavailable
        />
      )}
    </span>
  );
}
