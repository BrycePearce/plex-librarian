import type { ReactNode } from "react";
import { AlertTriangle, Check, Folder, X } from "lucide-react";
import { HoverPopover } from "../../components/HoverPopover";
import { ServiceIcon } from "../../components/ServiceIcons";
import type { ServiceIconName } from "../../components/ServiceIcons";
import { InfoTip } from "./InfoTip";

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
      title={info}
      className={`relative inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-[color,background-color,border-color,box-shadow] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary ${
        checked
          ? warning
            ? "border-warning/40 bg-warning/10 text-warning"
            : "border-primary/35 bg-primary/10 text-base-content"
          : warning
          ? "border-warning/30 bg-base-200/55 text-warning"
          : "border-base-300 bg-base-200/55 text-base-content/60"
      } ${
        disabled
          ? warning ? "opacity-75" : "opacity-40"
          : "cursor-pointer hover:border-base-content/25 hover:bg-base-200"
      }`}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {service
        ? <ServiceIcon service={service} className="size-4 shrink-0" />
        : <Folder className="size-4 shrink-0" />}
      <span className="whitespace-nowrap font-medium">{label}</span>
      {warning && <AlertTriangle className="size-3.5 shrink-0" />}
      {checked && !warning && (
        <Check
          className="size-3.5 shrink-0 text-primary"
          strokeWidth={2.5}
        />
      )}
    </label>
  );
}

export function DestinationOptions({
  arrService,
  arrLabel,
  arrVisible,
  arrWarning,
  arrInfo,
  deleteFromArr,
  arrDisabled,
  onArrChange,
  cleanupVisible,
  cleanupUsesQbittorrent,
  cleanupDownloads,
  cleanupWarning,
  cleanupInfo,
  cleanupDisabled,
  onCleanupChange,
}: {
  arrService?: "radarr" | "sonarr";
  arrLabel: string;
  arrVisible: boolean;
  arrWarning: boolean;
  arrInfo: string;
  deleteFromArr: boolean;
  arrDisabled: boolean;
  onArrChange: (checked: boolean) => void;
  cleanupVisible: boolean;
  cleanupUsesQbittorrent: boolean;
  cleanupDownloads: boolean;
  cleanupWarning: boolean;
  cleanupInfo: string;
  cleanupDisabled: boolean;
  onCleanupChange: (checked: boolean) => void;
}) {
  const destinationHelp = [
    `${arrLabel}: ${arrInfo}`,
    cleanupVisible
      ? `${cleanupUsesQbittorrent ? "qBittorrent" : "Downloaded files"}: ${cleanupInfo}`
      : null,
  ].filter(Boolean).join(" ");

  return (
    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
      <span className="mr-0.5 inline-flex items-center gap-1.5 text-xs text-base-content/45">
        Also clean up in
        <InfoTip text={destinationHelp} />
      </span>
      {arrVisible && (
        <DestinationOption
          service={arrService ?? "radarr"}
          label={arrLabel}
          info={arrInfo}
          checked={deleteFromArr}
          disabled={arrDisabled}
          warning={arrWarning}
          onChange={onArrChange}
        />
      )}
      {cleanupVisible && (
        <DestinationOption
          service={cleanupUsesQbittorrent ? "qbittorrent" : undefined}
          label={cleanupUsesQbittorrent ? "qBittorrent" : "Downloaded files"}
          info={cleanupInfo}
          checked={cleanupDownloads}
          disabled={cleanupDisabled}
          warning={cleanupWarning}
          onChange={onCleanupChange}
        />
      )}
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
                {arrReason ?? "No verified Sonarr or Radarr match is available."}
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
          ariaLabel={`Downloaded-file cleanup unavailable: ${
            cleanupReason ?? "no verified files"
          }`}
          popover={
            <>
              <div className="font-semibold text-error">Download cleanup unavailable</div>
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

export function PreviewStatus({
  loading,
  error,
  arrProblems,
  cleanupProblems,
}: {
  loading: boolean;
  error: string | null;
  arrProblems: Array<{ title: string; reason: string }>;
  cleanupProblems: Array<{ title: string; reason: string }>;
}) {
  return (
    <div className="mt-2 space-y-1 text-xs">
      {loading && (
        <p className="flex items-center gap-2 text-base-content/50">
          <span className="loading loading-spinner loading-xs" /> Verifying deletion paths…
        </p>
      )}
      {error && <p className="text-error">Could not verify deletion paths: {error}</p>}
      {!loading && !error && arrProblems.length > 0 && (
        <p className="text-warning">
          {arrProblems.length} {arrProblems.length === 1 ? "item has" : "items have"} no verified
          Arr destination and will use Plex only. Review the Arr warning for details.
        </p>
      )}
      {!loading && !error && cleanupProblems.length > 0 && (
        <p className="text-warning">
          Downloaded-file cleanup could not be verified for {cleanupProblems.length} {
            cleanupProblems.length === 1 ? "item" : "items"
          }: {cleanupProblems[0].reason}
        </p>
      )}
    </div>
  );
}
