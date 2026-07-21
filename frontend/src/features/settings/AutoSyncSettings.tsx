import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Clock3, Globe2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { isValidTimeZone, nextScheduledInstant } from "@shared/schedule";
import { api } from "../../lib/api";
import type { Settings } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { SettingsSection } from "./SettingsSection";

export function LoadingAutoSyncSettings() {
  return (
    <SettingsSection
      icon={Clock3}
      tone="secondary"
      title="Automatic sync"
      description="Choose when Plex Librarian refreshes library and viewing data."
    >
      <div
        className="auto-sync-content"
        aria-busy="true"
        aria-label="Loading automatic sync settings"
      >
        <div className="auto-sync-summary">
          <span className="skeleton size-10 rounded-xl" />
          <span className="grid gap-2">
            <span className="skeleton h-2 w-28" />
            <span className="skeleton h-4 w-52 max-w-full" />
            <span className="skeleton h-2.5 w-44 max-w-full" />
          </span>
          <span className="auto-sync-enable">
            <span className="skeleton h-3 w-12" />
            <span className="skeleton h-6 w-10 rounded-full" />
          </span>
        </div>

        <div className="auto-sync-controls">
          <LoadingAutoSyncControl valueWidth="w-24" />
          <LoadingAutoSyncControl valueWidth="w-48" />
        </div>

        <div className="auto-sync-catch-up">
          <span className="skeleton size-8 rounded-lg" />
          <span className="grid gap-2">
            <span className="skeleton h-3 w-36" />
            <span className="skeleton h-2.5 w-80 max-w-full" />
          </span>
          <span className="skeleton h-5 w-8 rounded-full" />
        </div>

        <span className="skeleton h-2.5 w-96 max-w-full" />
      </div>
    </SettingsSection>
  );
}

function LoadingAutoSyncControl({ valueWidth }: { valueWidth: string }) {
  return (
    <div className="auto-sync-control-card">
      <span className="skeleton size-8 rounded-lg" />
      <span className="grid gap-2">
        <span className="skeleton h-3 w-20" />
        <span className="skeleton h-2.5 w-32" />
      </span>
      <span className={`skeleton h-8 ${valueWidth}`} />
    </div>
  );
}

export function AutoSyncSettings({
  settings,
  lastSuccessfulSyncAt,
}: {
  settings: Settings;
  lastSuccessfulSyncAt: number | null | undefined;
}) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(settings.autoSyncEnabled);
  const [hour, setHour] = useState(settings.autoSyncHour);
  const [timeZone, setTimeZone] = useState(settings.autoSyncTimeZone);
  const [catchUp, setCatchUp] = useState(settings.autoSyncCatchUp);
  const [now, setNow] = useState(() => new Date());
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const update = useMutation({
    mutationFn: (partial: Partial<Settings>) => api.settings.update(partial),
    onSuccess: (updated, partial) => {
      // Merge only the field this request saved. Separate schedule controls can
      // change in quick succession, and an older full response must not overwrite
      // a newer optimistic choice from another control.
      qc.setQueryData<Settings>(
        queryKeys.settings.all,
        (current) => current ? { ...current, ...partial } : updated,
      );
      if (partial.autoSyncEnabled !== undefined) {
        setEnabled(updated.autoSyncEnabled);
      }
      if (partial.autoSyncHour !== undefined) setHour(updated.autoSyncHour);
      if (partial.autoSyncTimeZone !== undefined) {
        setTimeZone(updated.autoSyncTimeZone);
      }
      if (partial.autoSyncCatchUp !== undefined) {
        setCatchUp(updated.autoSyncCatchUp);
      }
    },
    onError: (_error, partial) => {
      // Revert only the failed control so independent controls do not flash back
      // to server state while another save is in flight.
      if (partial.autoSyncEnabled !== undefined) {
        setEnabled(settings.autoSyncEnabled);
      }
      if (partial.autoSyncHour !== undefined) setHour(settings.autoSyncHour);
      if (partial.autoSyncTimeZone !== undefined) {
        setTimeZone(settings.autoSyncTimeZone);
      }
      if (partial.autoSyncCatchUp !== undefined) {
        setCatchUp(settings.autoSyncCatchUp);
      }
    },
  });

  const eligibleAt = lastSuccessfulSyncAt == null ? now : new Date(
    Math.max(
      now.getTime(),
      lastSuccessfulSyncAt * 1000 + 23 * 60 * 60 * 1000 - 1,
    ),
  );
  const timeZoneValid = isValidTimeZone(timeZone);
  const nextRun = enabled && timeZoneValid && lastSuccessfulSyncAt !== undefined
    ? nextScheduledInstant(eligibleAt, hour, timeZone)
    : null;
  let nextRunLabel = "Automatic sync is off";
  if (enabled && !timeZoneValid) {
    nextRunLabel = "Enter a valid time zone";
  } else if (enabled && lastSuccessfulSyncAt === undefined) {
    nextRunLabel = "Calculating next sync…";
  } else if (nextRun) {
    nextRunLabel = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
      hour: "numeric",
      timeZone,
      timeZoneName: "short",
    }).format(nextRun);
  }

  const saveTimeZone = (value: string) => {
    const normalized = value.trim();
    setTimeZone(normalized);
    if (
      normalized !== settings.autoSyncTimeZone &&
      isValidTimeZone(normalized)
    ) {
      update.mutate({ autoSyncTimeZone: normalized });
    }
  };

  return (
    <SettingsSection
      icon={Clock3}
      tone="secondary"
      title="Automatic sync"
      description="Choose when Plex Librarian refreshes library and viewing data."
    >
      <div className={`auto-sync-content ${enabled ? "" : "is-disabled"}`}>
        <div className="auto-sync-summary">
          <span className="auto-sync-summary-icon" aria-hidden="true">
            <CalendarClock className="size-5" />
          </span>
          <div className="auto-sync-summary-copy">
            <span className="auto-sync-kicker">
              {enabled ? "Next automatic sync" : "Automatic sync paused"}
            </span>
            <strong>{nextRunLabel}</strong>
            <span>
              {enabled
                ? `Daily at ${formatScheduleHour(hour)} · ${timeZone}`
                : "Turn it on to keep every library refreshed automatically."}
            </span>
          </div>
          <div className="auto-sync-enable">
            <span className={`auto-sync-status ${enabled ? "is-active" : ""}`}>
              <i /> {enabled ? "Active" : "Off"}
            </span>
            <input
              type="checkbox"
              className="toggle toggle-secondary"
              checked={enabled}
              onChange={(event) => {
                const value = event.target.checked;
                setEnabled(value);
                update.mutate({ autoSyncEnabled: value });
              }}
              aria-label="Enable daily automatic sync"
            />
          </div>
        </div>

        <div className="auto-sync-controls">
          <label className="auto-sync-control-card">
            <span className="auto-sync-control-icon" aria-hidden="true">
              <Clock3 className="size-4" />
            </span>
            <span className="auto-sync-control-copy">
              <strong>Run time</strong>
              <small>Uses the selected time zone</small>
            </span>
            <select
              className="select select-bordered select-sm"
              value={hour}
              disabled={!enabled}
              onChange={(event) => {
                const value = Number(event.target.value);
                setHour(value);
                update.mutate({ autoSyncHour: value });
              }}
              aria-label="Automatic sync hour"
            >
              {Array.from({ length: 24 }, (_, value) => (
                <option key={value} value={value}>
                  {formatScheduleHour(value)}
                </option>
              ))}
            </select>
          </label>

          <div className="auto-sync-control-card">
            <span className="auto-sync-control-icon" aria-hidden="true">
              <Globe2 className="size-4" />
            </span>
            <label
              className="auto-sync-control-copy"
              htmlFor="auto-sync-time-zone"
            >
              <strong>Time zone</strong>
              <small>Follows daylight-saving changes</small>
            </label>
            <div className="auto-sync-time-zone-control">
              <input
                id="auto-sync-time-zone"
                className={`input input-bordered input-sm ${timeZoneValid ? "" : "input-error"}`}
                list="auto-sync-time-zones"
                value={timeZone}
                disabled={!enabled}
                onChange={(event) => setTimeZone(event.target.value)}
                onBlur={(event) => saveTimeZone(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                aria-describedby={!timeZoneValid ? "auto-sync-time-zone-error" : undefined}
              />
              <datalist id="auto-sync-time-zones">
                {supportedTimeZones().map((zone) => <option key={zone} value={zone} />)}
              </datalist>
              <button
                type="button"
                className={`btn btn-ghost btn-xs auto-sync-use-local ${
                  browserTimeZone === timeZone ? "is-hidden" : ""
                }`}
                disabled={!enabled || browserTimeZone === timeZone}
                onClick={() => saveTimeZone(browserTimeZone)}
                title={`Use browser time zone: ${browserTimeZone}`}
              >
                Use local
              </button>
            </div>
            <small
              id="auto-sync-time-zone-error"
              className={`auto-sync-field-error ${timeZoneValid ? "" : "is-visible"}`}
              aria-hidden={timeZoneValid}
            >
              Enter a valid region, such as America/Los_Angeles.
            </small>
          </div>
        </div>

        <label className="auto-sync-catch-up">
          <span className="auto-sync-control-icon" aria-hidden="true">
            <RefreshCw className="size-4" />
          </span>
          <span>
            <strong>Catch up after downtime</strong>
            <small>
              Sync on startup when the last successful refresh is more than 24 hours old.
            </small>
          </span>
          <input
            type="checkbox"
            className="toggle toggle-secondary toggle-sm"
            checked={catchUp}
            disabled={!enabled}
            onChange={(event) => {
              const value = event.target.checked;
              setCatchUp(value);
              update.mutate({ autoSyncCatchUp: value });
            }}
            aria-label="Catch up automatic sync after downtime"
          />
        </label>

        {update.isError && (
          <div className="auto-sync-save-error" role="alert">
            {update.error instanceof Error ? update.error.message : "Failed to save schedule"}
          </div>
        )}
        <p className="auto-sync-footnote">
          The scheduler checks once per minute during the selected hour. If daylight saving removes
          that hour, the run resumes the following day.
        </p>
      </div>
    </SettingsSection>
  );
}

function formatScheduleHour(hour: number): string {
  const date = new Date(Date.UTC(2020, 0, 1, hour));
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function supportedTimeZones(): string[] {
  const supportedValuesOf = (
    Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    }
  ).supportedValuesOf;
  return supportedValuesOf ? supportedValuesOf("timeZone") : [];
}
