import type { ReactNode } from "react";
import { AlertTriangle, Folder, X } from "lucide-react";
import { HoverPopover } from "../../components/HoverPopover";
import { ServiceIcon } from "../../components/ServiceIcons";
import type { ServiceIconName } from "../../components/ServiceIcons";
import type { ArrCleanupTarget } from "../../lib/api";
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
      className={`inline-flex items-center gap-1.5 text-sm transition-colors ${
        warning ? "text-warning" : "text-base-content/75"
      } ${disabled ? warning ? "opacity-80" : "opacity-45" : "cursor-pointer"}`}
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
      {warning && <AlertTriangle className="size-3.5 shrink-0" />}
      <InfoTip text={info} />
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
  return (
    <div className="mt-2 flex flex-wrap items-center justify-end gap-x-5 gap-y-2">
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
  label,
  ariaLabel,
  popover,
  className,
  unavailable = false,
}: {
  service?: ServiceIconName;
  label?: string;
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
        {service
          ? <ServiceIcon service={service} className="size-3.5" />
          : <span className="text-[9px] font-bold">{label}</span>}
        {unavailable && (
          <span className="absolute -right-1 -top-1 flex size-3 items-center justify-center rounded-full bg-error text-error-content ring-1 ring-base-200">
            <X className="size-2.5" strokeWidth={3} />
          </span>
        )}
      </span>
    </HoverPopover>
  );
}

export function PlannedServiceIcons({
  deleteFromArr,
  arrService,
  arrStatus,
  arrReason,
  arrTargets,
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
  arrTargets: ArrCleanupTarget[];
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
  return (
    <span className="flex shrink-0 items-center gap-1">
      <ServiceMark
        service="plex"
        ariaLabel="Delete the files indexed by Plex"
        popover={
          <>
            <div className="font-semibold">Plex</div>
            <div className="mt-1 text-base-content/55">
              Deletes the media files at the locations Plex has indexed for this item.
            </div>
          </>
        }
        className="bg-warning/20 text-warning"
      />
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
      {deleteFromArr && arrTargets.map((target, index) => (
        <ServiceMark
          key={`${target.instanceName}:${target.type}:${index}`}
          service={target.type}
          ariaLabel={`Delete through ${target.instanceName}`}
          popover={
            <>
              <div className="font-semibold">
                {target.type === "radarr" ? "Radarr" : "Sonarr"}
              </div>
              {target.instanceName.toLocaleLowerCase() !== target.type && (
                <div className="mt-0.5 text-base-content/70">{target.instanceName}</div>
              )}
              <div className="mt-1 text-base-content/55">
                Deletes the managed title and its files from this instance.
              </div>
            </>
          }
          className={target.type === "radarr"
            ? "bg-primary/20 text-primary"
            : "bg-info/20 text-info"}
        />
      ))}
      {cleanupDownloads && !cleanupAvailable && (
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
      {cleanupDownloads && (downloadJobCount > 0 || downloadCleanupResuming) && (
        <ServiceMark
          service="qbittorrent"
          ariaLabel={downloadJobCount > 0
            ? `Remove ${downloadJobCount} verified qBittorrent job${
              downloadJobCount === 1 ? "" : "s"
            }`
            : "Resume previously started qBittorrent cleanup"}
          popover={
            <>
              <div className="font-semibold">qBittorrent</div>
              <div className="mt-1 text-base-content/55">
                {downloadJobCount > 0
                  ? `Removes ${downloadJobCount} verified job${
                    downloadJobCount === 1 ? "" : "s"
                  } and asks qBittorrent to delete the downloaded files.`
                  : "Resumes a previously started qBittorrent cleanup before Arr deletion."}
              </div>
            </>
          }
          className="bg-secondary/20 text-secondary"
        />
      )}
      {cleanupDownloads && hardlinkFileCount > 0 && (
        <ServiceMark
          label="HL"
          ariaLabel={`Remove ${hardlinkFileCount} verified orphaned hardlink${
            hardlinkFileCount === 1 ? "" : "s"
          }`}
          popover={
            <>
              <div className="font-semibold">Verified hardlinks</div>
              <div className="mt-1 text-base-content/55">
                Unlinks {hardlinkFileCount} orphaned download file{
                  hardlinkFileCount === 1 ? "" : "s"
                } after rechecking filesystem identity.
              </div>
            </>
          }
          className="bg-success/20 text-success"
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
