import { useMutation } from "@tanstack/react-query";
import { ListPlus } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api.ts";
import type { ArrInstance, QbittorrentInstance, SeerrInstance } from "../../lib/api.ts";
import { suggestedSeerrUrl } from "./seerrUrl.ts";

export function SeerrConnectionWizard({
  instance,
  arrInstances,
  qbittorrentInstances,
  onCancel,
  onSaved,
}: {
  instance: SeerrInstance | null;
  arrInstances: readonly ArrInstance[];
  qbittorrentInstances: readonly QbittorrentInstance[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const suggestedUrl = instance ? "" : suggestedSeerrUrl([
    ...arrInstances.map(({ url }) => ({ url })),
    ...qbittorrentInstances.map(({ url }) => ({ url })),
  ]);
  const [form, setForm] = useState({
    name: instance?.name ?? "Seerr",
    url: instance?.url ?? suggestedUrl,
    apiKey: "",
  });
  const [urlWasSuggested, setUrlWasSuggested] = useState(Boolean(suggestedUrl));
  const save = useMutation({
    mutationFn: () =>
      instance === null ? api.seerr.createInstance(form) : api.seerr.updateInstance(instance.id, {
        name: form.name,
        url: form.url,
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      }),
    onSuccess: onSaved,
  });

  return (
    <div className="modal-box polished-modal max-w-2xl">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <ListPlus className="size-5" />
        </span>
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold">
            {instance ? `Edit ${instance.name}` : "Connect Seerr"}
            <span className="badge badge-warning badge-outline badge-sm">Beta</span>
          </h3>
          <p className="mt-1 text-sm text-base-content/60">
            Connect the request API to measure requester follow-through after a full sync.
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
            placeholder="http://seerr:5055"
            required
          />
          <span className="mt-1 text-xs text-base-content/45">
            {urlWasSuggested
              ? "Suggested because your existing media connections share this host. Seerr commonly uses port 5055; verify it before saving."
              : "Use an address reachable from the Plex Librarian container, not localhost."}
          </span>
        </label>
        <label className="form-control flex flex-col">
          <span className="label-text mb-1 text-xs font-medium">
            API key{instance && " — leave blank to keep it"}
          </span>
          <input
            className="input input-bordered w-full font-mono text-sm [-webkit-text-security:disc]"
            type="text"
            value={form.apiKey}
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
            required={!instance}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
          />
          <span className="mt-1 text-xs text-base-content/45">
            Find it in Seerr under Settings → General. Saving tests authenticated request access
            before storing it.
          </span>
        </label>

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
            disabled={save.isPending ||
              !form.name.trim() ||
              !form.url.trim() ||
              (!instance && !form.apiKey.trim())}
          >
            {save.isPending && <span className="loading loading-spinner loading-xs" />}{" "}
            Save connection
          </button>
        </div>
      </form>
    </div>
  );
}
