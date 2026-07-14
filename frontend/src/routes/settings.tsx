import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Check,
  Mail,
  PlugZap,
  Server,
  Settings as SettingsIcon,
  Trash2,
  Users,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { api } from "../lib/api";
import { requireAuth } from "../lib/requireAuth";
import type { ArrInstance, Settings } from "../lib/api";
import { PageHeader } from "../components/Workspace";

const MAX_INACTIVITY_DAYS = 36_500;
const MIN_USER_ACTIVITY_RETENTION_DAYS = 30;

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
    <div className="workspace-page settings-page space-y-6 max-w-5xl">
      <PageHeader
        eyebrow="Application preferences"
        title="Settings"
        description="Tune library analysis, user activity, and media-manager integrations."
        icon={SettingsIcon}
      />

      <div className="settings-sections">
        <ArrIntegrationSection />

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
            description="Keep user IP, device, and playback observations for at least the full 30-day sharing-risk window. Set to 0 to keep them forever."
          >
            {data
              ? (
                <DebouncedDaysInput
                  initialDays={data.ipHistoryRetentionDays}
                  mutationFn={(value) =>
                    api.settings.update({ ipHistoryRetentionDays: value })}
                  getSavedValue={(updated) => updated.ipHistoryRetentionDays}
                  minimumNonZero={MIN_USER_ACTIVITY_RETENTION_DAYS}
                  invalidateQueryKey={["users"]}
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
              : (
                <LoadingDaysInput label="Loading pending invitation threshold" />
              )}
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
              : (
                <LoadingDaysInput label="Loading overdue invitation threshold" />
              )}
          </SettingRow>
        </SettingsSection>
      </div>
    </div>
  );
}

function ArrIntegrationSection() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["arr-integrations"],
    queryFn: api.arr.get,
  });
  const { data: libraryData } = useQuery({
    queryKey: ["libraries", "arr-settings"],
    queryFn: api.libraries.listAll,
  });
  const removeDialogRef = useRef<HTMLDialogElement>(null);
  const [pendingRemoval, setPendingRemoval] = useState<ArrInstance | null>(
    null,
  );
  const [type, setType] = useState<"radarr" | "sonarr">("radarr");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  const create = useMutation({
    mutationFn: api.arr.createInstance,
    onSuccess: () => {
      setName("");
      setUrl("");
      setApiKey("");
      void qc.invalidateQueries({ queryKey: ["arr-integrations"] });
    },
  });
  const remove = useMutation({
    mutationFn: api.arr.deleteInstance,
    onSuccess: () => {
      removeDialogRef.current?.close();
      setPendingRemoval(null);
      void qc.invalidateQueries({ queryKey: ["arr-integrations"] });
    },
  });
  const test = useMutation({ mutationFn: api.arr.testInstance });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({ type, name, url, apiKey });
  }

  const videoLibraries = (libraryData?.libraries ?? []).filter((library) =>
    library.type === "movie" || library.type === "show"
  );
  const pendingRemovalMappingCount = data?.mappings.filter((mapping) =>
    mapping.instanceId === pendingRemoval?.id
  ).length ?? 0;

  return (
    <SettingsSection
      icon={Server}
      tone="primary"
      title="Sonarr & Radarr"
      description="Let your media manager remove tracked movies and shows before Plex is refreshed."
    >
      <div className="space-y-4">
        <form onSubmit={submit} className="grid gap-3 md:grid-cols-2">
          <label className="form-control">
            <span className="label-text mb-1 text-xs font-medium">
              Application
            </span>
            <select
              className="select select-bordered select-sm"
              value={type}
              onChange={(event) =>
                setType(event.target.value as "radarr" | "sonarr")}
            >
              <option value="radarr">Radarr</option>
              <option value="sonarr">Sonarr</option>
            </select>
          </label>
          <label className="form-control">
            <span className="label-text mb-1 text-xs font-medium">Name</span>
            <input
              className="input input-bordered input-sm"
              placeholder={type === "radarr" ? "Movies" : "TV"}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          <label className="form-control">
            <span className="label-text mb-1 text-xs font-medium">URL</span>
            <input
              className="input input-bordered input-sm"
              placeholder={type === "radarr"
                ? "http://radarr:7878"
                : "http://sonarr:8989"}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
            />
          </label>
          <label className="form-control">
            <span className="label-text mb-1 text-xs font-medium">API key</span>
            <input
              className="input input-bordered input-sm"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              required
            />
          </label>
          <div className="md:col-span-2 flex items-center gap-3">
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={create.isPending}
            >
              {create.isPending
                ? <span className="loading loading-spinner loading-xs" />
                : <PlugZap className="size-4" />}
              Test and add
            </button>
            {create.isError && (
              <span className="text-xs text-error">{create.error.message}</span>
            )}
          </div>
        </form>

        {isLoading && <span className="loading loading-spinner loading-sm" />}
        {error && <p className="text-sm text-error">{error.message}</p>}
        {(data?.instances.length ?? 0) > 0 && (
          <div className="space-y-2">
            {data!.instances.map((instance) => (
              <div
                key={instance.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-base-300 bg-base-200/35 p-3"
              >
                <span
                  className={`badge badge-sm ${
                    instance.type === "radarr"
                      ? "badge-primary"
                      : "badge-secondary"
                  }`}
                >
                  {instance.type === "radarr" ? "Radarr" : "Sonarr"}
                </span>
                <span className="font-medium">{instance.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-base-content/50">
                  {instance.url}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => test.mutate(instance.id)}
                  disabled={test.isPending}
                >
                  Test
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs text-error"
                  aria-label={`Remove ${instance.name}`}
                  onClick={() => {
                    remove.reset();
                    setPendingRemoval(instance);
                    removeDialogRef.current?.showModal();
                  }}
                  disabled={remove.isPending}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
            {test.isSuccess && (
              <p className="text-xs text-success">
                Connection successful{test.data.version
                  ? ` — version ${test.data.version}`
                  : ""}.
              </p>
            )}
            {test.isError && (
              <p className="text-xs text-error">{test.error.message}</p>
            )}
          </div>
        )}

        {data && data.instances.length > 0 && videoLibraries.length > 0 && (
          <div className="space-y-2 border-t border-base-300 pt-4">
            <div>
              <h3 className="font-medium">Library mappings</h3>
              <p className="text-xs text-base-content/55">
                Mapped libraries use coordinated deletion by default. Multiple
                instances are supported.
              </p>
            </div>
            {videoLibraries.map((library) => {
              const mappings = data.mappings.filter((mapping) =>
                mapping.libraryKey === library.key
              );
              return (
                <LibraryArrMappingRow
                  key={`${library.key}:${
                    mappings.map((mapping) => mapping.instanceId).join(",")
                  }:${mappings[0]?.addImportExclusion ?? true}`}
                  library={library}
                  instances={data.instances.filter((instance) =>
                    instance.type ===
                      (library.type === "movie" ? "radarr" : "sonarr")
                  )}
                  mappedIds={mappings.map((mapping) =>
                    mapping.instanceId
                  )}
                  initialExclusion={mappings[0]?.addImportExclusion ?? true}
                />
              );
            })}
          </div>
        )}

        <dialog
          ref={removeDialogRef}
          className="modal"
          onClose={() => {
            if (!remove.isPending) setPendingRemoval(null);
          }}
        >
          <div className="modal-box polished-modal">
            <h3 className="flex items-center gap-2 text-lg font-bold">
              <Trash2 className="size-5 text-error" /> Remove connection?
            </h3>
            <p className="py-3 text-sm text-base-content/70">
              Remove <strong>{pendingRemoval?.name}</strong> from Plex
              Librarian? This also removes{" "}
              {pendingRemovalMappingCount === 1
                ? "1 library mapping"
                : `${pendingRemovalMappingCount} library mappings`}. It does not
              delete anything from Sonarr, Radarr, Plex, or disk.
            </p>
            {remove.isError && (
              <p className="text-sm text-error">{remove.error.message}</p>
            )}
            <div className="modal-action">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => removeDialogRef.current?.close()}
                disabled={remove.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-error btn-sm"
                onClick={() => {
                  if (pendingRemoval) remove.mutate(pendingRemoval.id);
                }}
                disabled={!pendingRemoval || remove.isPending}
              >
                {remove.isPending
                  ? <span className="loading loading-spinner loading-xs" />
                  : <Trash2 className="size-4" />}
                Remove connection
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button type="submit" disabled={remove.isPending}>close</button>
          </form>
        </dialog>
      </div>
    </SettingsSection>
  );
}

function LibraryArrMappingRow(
  { library, instances, mappedIds, initialExclusion }: {
    library: import("../lib/api").Library;
    instances: import("../lib/api").ArrInstance[];
    mappedIds: number[];
    initialExclusion: boolean;
  },
) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(new Set(mappedIds));
  const [addExclusion, setAddExclusion] = useState(initialExclusion);
  const save = useMutation({
    mutationFn: () =>
      api.arr.saveLibraryMapping(library.key, [...selected], addExclusion),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["arr-integrations"] }),
  });

  return (
    <div className="rounded-lg border border-base-300 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-40 font-medium">{library.title}</span>
        <div className="flex flex-1 flex-wrap gap-3">
          {instances.length === 0
            ? (
              <span className="text-xs text-base-content/45">
                No compatible instance configured
              </span>
            )
            : instances.map((instance) => (
              <label
                key={instance.id}
                className="flex cursor-pointer items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs"
                  checked={selected.has(instance.id)}
                  onChange={() => {
                    const next = new Set(selected);
                    if (next.has(instance.id)) next.delete(instance.id);
                    else next.add(instance.id);
                    setSelected(next);
                  }}
                />
                {instance.name}
              </label>
            ))}
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          {save.isPending
            ? <span className="loading loading-spinner loading-xs" />
            : "Save"}
        </button>
      </div>
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-base-content/60">
        <input
          type="checkbox"
          className="checkbox checkbox-xs"
          checked={addExclusion}
          onChange={(event) => setAddExclusion(event.target.checked)}
          disabled={selected.size === 0}
        />
        Add an import-list exclusion when deleting
      </label>
      {save.isError && (
        <p className="mt-2 text-xs text-error">{save.error.message}</p>
      )}
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
    <section
      className={`workspace-surface settings-section settings-section-${tone}`}
    >
      <header className="settings-section-header">
        <span className="settings-section-icon">
          <Icon className="size-5" />
        </span>
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
  {
    initialDays,
    mutationFn,
    getSavedValue,
    invalidateQueryKey,
    maxDays,
    minimumNonZero,
  }: {
    initialDays: number;
    mutationFn: (value: number) => Promise<Settings>;
    getSavedValue: (updated: Settings) => number;
    // Other cached queries that read this setting's value and need to be refetched on
    // save (e.g. the Users page reads inactiveUserDays) — settings itself is patched
    // straight into the cache below via setQueryData, but dependent queries have no
    // such direct link and would otherwise keep serving a stale threshold.
    invalidateQueryKey?: unknown[];
    maxDays?: number;
    minimumNonZero?: number;
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
    (minimumNonZero === undefined || parsed === 0 ||
      parsed >= minimumNonZero) &&
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
        title={minimumNonZero === undefined
          ? undefined
          : `Enter 0 or at least ${minimumNonZero} days`}
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
