import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Check,
  Mail,
  Settings as SettingsIcon,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { requireAuth } from "../lib/requireAuth";
import type { Settings } from "../lib/api";
import { PageHeader } from "../components/Workspace";

const MAX_INACTIVITY_DAYS = 36_500;

export const Route = createFileRoute("/settings")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: SettingsPage,
});

function SettingsPage() {
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: api.settings.get,
  });

  return (
    <div className="workspace-page settings-page space-y-6 max-w-3xl">
      <PageHeader
        eyebrow="Application preferences"
        title="Settings"
        description="Tune how Plex Librarian identifies stale content and user activity."
        icon={SettingsIcon}
      />

      <div className="settings-sections">
        <SettingsSection
          icon={Archive}
          tone="primary"
          title="Stale content"
          description="Control when unwatched library items become candidates for review."
        >
          <SettingRow
            title="Default minimum age for never-watched items"
            description="Unwatched items added within this many days are not considered stale. Libraries without their own override use this default."
          >
            {data
              ? (
                <DebouncedDaysInput
                  initialDays={data.staleMinAgeDays}
                  mutationFn={(value) =>
                    api.settings.update({ staleMinAgeDays: value })}
                  getSavedValue={(updated) => updated.staleMinAgeDays}
                />
              )
              : <LoadingDaysInput label="Loading default minimum item age" />}
          </SettingRow>
        </SettingsSection>

        <SettingsSection
          icon={Users}
          tone="accent"
          title="User activity"
          description="Define inactivity and how long detailed playback observations are retained."
        >
          <SettingRow
            title="Inactive user threshold"
            description="Users who haven't watched anything in at least this many days are flagged inactive on the Users page."
          >
            {data
              ? (
                <DebouncedDaysInput
                  initialDays={data.inactiveUserDays}
                  mutationFn={(value) =>
                    api.settings.update({ inactiveUserDays: value })}
                  getSavedValue={(updated) => updated.inactiveUserDays}
                  invalidateQueryKey={["users"]}
                  maxDays={MAX_INACTIVITY_DAYS}
                />
              )
              : <LoadingDaysInput label="Loading inactive user threshold" />}
          </SettingRow>
          <SettingRow
            title="User activity retention"
            description="Keep user IP, device, and playback observations for this many days. Set to 0 to keep them forever."
          >
            {data
              ? (
                <DebouncedDaysInput
                  initialDays={data.ipHistoryRetentionDays}
                  mutationFn={(value) =>
                    api.settings.update({ ipHistoryRetentionDays: value })}
                  getSavedValue={(updated) => updated.ipHistoryRetentionDays}
                />
              )
              : <LoadingDaysInput label="Loading user activity retention" />}
          </SettingRow>
        </SettingsSection>

        <SettingsSection
          icon={Mail}
          tone="secondary"
          title="Invitations"
          description="Choose when unanswered Plex invitations need attention."
        >
          <SettingRow
            title="Pending invitation threshold"
            description="Pending Plex invitations at least this old are highlighted for follow-up on the Users page."
          >
            {data
              ? (
                <DebouncedDaysInput
                  initialDays={data.pendingInviteStaleDays}
                  mutationFn={(value) =>
                    api.settings.update({ pendingInviteStaleDays: value })}
                  getSavedValue={(updated) => updated.pendingInviteStaleDays}
                  invalidateQueryKey={["users", "invitations"]}
                  maxDays={MAX_INACTIVITY_DAYS}
                />
              )
              : <LoadingDaysInput label="Loading pending invitation threshold" />}
          </SettingRow>
          <SettingRow
            title="Overdue invitation threshold"
            description="Pending invitations at least this old are marked overdue. This must be at least the pending invitation threshold."
          >
            {data
              ? (
                <DebouncedDaysInput
                  initialDays={data.pendingInviteCriticalDays}
                  mutationFn={(value) =>
                    api.settings.update({ pendingInviteCriticalDays: value })}
                  getSavedValue={(updated) => updated.pendingInviteCriticalDays}
                  invalidateQueryKey={["users", "invitations"]}
                  maxDays={MAX_INACTIVITY_DAYS}
                />
              )
              : <LoadingDaysInput label="Loading overdue invitation threshold" />}
          </SettingRow>
        </SettingsSection>
      </div>
    </div>
  );
}

function SettingsSection({ icon: Icon, tone, title, description, children }: {
  icon: typeof Archive;
  tone: "primary" | "secondary" | "accent";
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className={`workspace-surface settings-section settings-section-${tone}`}>
      <header className="settings-section-header">
        <span className="settings-section-icon"><Icon className="size-5" /></span>
        <span>
          <small>Preferences</small>
          <h2>{title}</h2>
          <p>{description}</p>
        </span>
      </header>
      <div className="settings-section-fields">{children}</div>
    </section>
  );
}

function SettingRow({ title, description, children }: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-field-row">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  );
}

function LoadingDaysInput({ label }: { label: string }) {
  return (
    <input
      type="number"
      className="input input-bordered input-sm w-24"
      disabled
      aria-label={label}
    />
  );
}

// Only rendered once `data` has loaded (see SettingsPage above), so local editing state
// can be initialized directly from the server value on mount — no Effect syncing data
// into state, and so no frame where "not loaded yet" could be misread as "invalid".
// Generic over which settings key it saves (see api.settings.update's comment for why
// two of these can save independently without clobbering each other).
function DebouncedDaysInput(
  { initialDays, mutationFn, getSavedValue, invalidateQueryKey, maxDays }: {
    initialDays: number;
    mutationFn: (value: number) => Promise<Settings>;
    getSavedValue: (updated: Settings) => number;
    // Other cached queries that read this setting's value and need to be refetched on
    // save (e.g. the Users page reads inactiveUserDays) — settings itself is patched
    // straight into the cache below via setQueryData, but dependent queries have no
    // such direct link and would otherwise keep serving a stale threshold.
    invalidateQueryKey?: unknown[];
    maxDays?: number;
  },
) {
  const qc = useQueryClient();
  const [days, setDays] = useState(String(initialDays));
  const lastSavedRef = useRef(initialDays);

  const [justSaved, setJustSaved] = useState(false);
  const savedTimeoutRef = useRef<number | undefined>(undefined);

  const update = useMutation({
    mutationFn,
    onSuccess: (updated) => {
      qc.setQueryData(["settings"], updated);
      if (invalidateQueryKey) {
        void qc.invalidateQueries({ queryKey: invalidateQueryKey });
      }
      lastSavedRef.current = getSavedValue(updated);
      setJustSaved(true);
      clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = setTimeout(() => setJustSaved(false), 2000);
    },
  });

  useEffect(() => () => clearTimeout(savedTimeoutRef.current), []);

  const parsed = Number(days);
  const valid = days !== "" && Number.isInteger(parsed) && parsed >= 0 &&
    (maxDays === undefined || parsed <= maxDays);

  // Debounced auto-save: waits for typing to settle so we don't PATCH on every keystroke.
  useEffect(() => {
    if (!valid || parsed === lastSavedRef.current) return;
    const timer = setTimeout(() => update.mutate(parsed), 500);
    return () => clearTimeout(timer);
  }, [days, valid, parsed]);

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={0}
        max={maxDays}
        step={1}
        className={`input input-bordered input-sm w-24 ${
          !valid ? "input-error" : ""
        }`}
        value={days}
        onChange={(e) => setDays(e.target.value)}
      />
      <span className="text-sm text-base-content/40">days</span>
      {update.isPending && (
        <span className="loading loading-spinner loading-xs text-base-content/40" />
      )}
      <span
        className={`flex items-center gap-1 text-xs text-success transition-opacity duration-300 ${
          justSaved && !update.isPending ? "opacity-100" : "opacity-0"
        }`}
      >
        <Check className="w-3.5 h-3.5" /> Saved
      </span>
      {update.isError && (
        <span className="text-xs text-error">
          {update.error instanceof Error
            ? update.error.message
            : "Failed to save"}
        </span>
      )}
    </div>
  );
}
