import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Download } from "lucide-react";
import { api } from "../../lib/api";
import type { ArrInstance, QbittorrentInstance } from "../../lib/api";
import { suggestedQbittorrentUrl } from "./qbittorrentUrl";

interface FormState {
  name: string;
  url: string;
  username: string;
  password: string;
}

export function QbittorrentConnectionWizard({
  instance,
  arrInstances,
  onCancel,
  onSaved,
}: {
  instance: QbittorrentInstance | null;
  arrInstances: readonly ArrInstance[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const suggestedUrl = instance ? "" : suggestedQbittorrentUrl(arrInstances);
  const [form, setForm] = useState<FormState>({
    name: instance?.name ?? "qBittorrent",
    url: instance?.url ?? suggestedUrl,
    username: "",
    password: "",
  });
  const [urlWasSuggested, setUrlWasSuggested] = useState(Boolean(suggestedUrl));
  const [clearCredentials, setClearCredentials] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      instance === null
        ? api.qbittorrent.createInstance(form)
        : api.qbittorrent.updateInstance(instance.id, {
          name: form.name,
          url: form.url,
          ...(clearCredentials ? { username: "", password: "" } : {
            ...(form.username ? { username: form.username } : {}),
            ...(form.password ? { password: form.password } : {}),
          }),
        }),
    onSuccess: onSaved,
  });

  return (
    <div className="modal-box polished-modal max-w-2xl">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <Download className="size-5" />
        </span>
        <div>
          <h3 className="text-lg font-bold">
            {instance ? `Edit ${instance.name}` : "Connect qBittorrent"}
          </h3>
          <p className="mt-1 text-sm text-base-content/60">
            Connect the Web UI to inspect torrent metadata and optionally remove
            payloads during coordinated deletion.
          </p>
        </div>
      </div>

      {save.isError && (
        <div role="alert" className="alert alert-error mt-4 text-sm">
          {save.error.message}
        </div>
      )}

      <form
        className="mt-5 space-y-4"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <label className="form-control flex flex-col">
          <span className="label-text mb-1 text-xs font-medium">
            Connection name
          </span>
          <input
            className="input input-bordered w-full"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            required
          />
        </label>
        <label className="form-control flex flex-col">
          <span className="label-text mb-1 text-xs font-medium">URL</span>
          <input
            className="input input-bordered w-full font-mono text-sm"
            type="url"
            value={form.url}
            onChange={(event) => {
              setUrlWasSuggested(false);
              setForm({ ...form, url: event.target.value });
            }}
            placeholder="http://192.168.1.10:8080"
            required
          />
          <span className="mt-1 text-xs text-base-content/45">
            {urlWasSuggested
              ? "Suggested from your Sonarr/Radarr host using qBittorrent's default port. Verify it before continuing."
              : "Use an address reachable from the Plex Librarian container, not localhost."}
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="form-control flex flex-col">
            <span className="label-text mb-1 text-xs font-medium">
              Username{instance && " — leave blank to keep it"}
            </span>
            <input
              className="input input-bordered w-full"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              value={form.username}
              onChange={(event) =>
                setForm({ ...form, username: event.target.value })}
              disabled={clearCredentials}
            />
          </label>
          <label className="form-control flex flex-col">
            <span className="label-text mb-1 text-xs font-medium">
              Password{instance && " — leave blank to keep it"}
            </span>
            <input
              type="text"
              className="input input-bordered w-full [-webkit-text-security:disc]"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              value={form.password}
              onChange={(event) =>
                setForm({ ...form, password: event.target.value })}
              disabled={clearCredentials}
            />
          </label>
        </div>
        {instance &&
          (instance.usernameConfigured || instance.passwordConfigured) && (
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="checkbox checkbox-xs"
              checked={clearCredentials}
              onChange={(event) => setClearCredentials(event.target.checked)}
            />
            Clear saved username and password and use authentication bypass
          </label>
        )}
        <p className="text-xs text-base-content/50">
          Credentials may be blank only when qBittorrent bypasses Web UI
          authentication for the Plex Librarian host or subnet. Saving tests the
          connection before storing it.
        </p>

        <div className="modal-action">
          <button
            type="button"
            className="btn btn-sm"
            onClick={onCancel}
            disabled={save.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={save.isPending || !form.name.trim() || !form.url.trim()}
          >
            {save.isPending && (
              <span className="loading loading-spinner loading-xs" />
            )} Save connection
          </button>
        </div>
      </form>
    </div>
  );
}
