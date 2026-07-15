import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Download, Plus, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import type { QbittorrentInstance } from "../../lib/api";

interface FormState {
  name: string;
  url: string;
  username: string;
  password: string;
}

const emptyForm: FormState = {
  name: "qBittorrent",
  url: "http://qbittorrent:8080",
  username: "",
  password: "",
};

export function QbittorrentConnections() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["qbittorrent-integrations"],
    queryFn: api.qbittorrent.get,
  });
  const [editing, setEditing] = useState<QbittorrentInstance | null | "new">(
    null,
  );
  const [form, setForm] = useState<FormState>(emptyForm);
  const [clearCredentials, setClearCredentials] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      editing === "new"
        ? api.qbittorrent.createInstance(form)
        : api.qbittorrent.updateInstance(editing!.id, {
          name: form.name,
          url: form.url,
          ...(clearCredentials ? { username: "", password: "" } : {
            ...(form.username ? { username: form.username } : {}),
            ...(form.password ? { password: form.password } : {}),
          }),
        }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["qbittorrent-integrations"] });
      setEditing(null);
      setClearCredentials(false);
      setForm(emptyForm);
    },
  });
  const remove = useMutation({
    mutationFn: api.qbittorrent.deleteInstance,
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["qbittorrent-integrations"] }),
  });
  const test = useMutation({ mutationFn: api.qbittorrent.testInstance });

  function edit(instance: QbittorrentInstance) {
    save.reset();
    setClearCredentials(false);
    setEditing(instance);
    setForm({
      name: instance.name,
      url: instance.url,
      username: "",
      password: "",
    });
  }

  return (
    <section className="border-t border-base-300 pt-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-medium">Download client</h3>
          <p className="text-xs text-base-content/55">
            Connect qBittorrent to inspect and optionally remove verified
            torrent payloads during deletion.
          </p>
        </div>
        {!data?.envConfigured && editing === null && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setEditing("new");
              setClearCredentials(false);
              setForm(emptyForm);
            }}
          >
            <Plus className="size-4" /> Add qBittorrent
          </button>
        )}
      </div>

      {isLoading &&
        <span className="mt-3 loading loading-spinner loading-sm" />}
      {error && <p className="mt-2 text-xs text-error">{error.message}</p>}
      {data?.envConfigured && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-base-300 bg-base-200/35 p-3">
          <Download className="size-4 text-primary" />
          <span className="text-sm font-medium">qBittorrent (environment)</span>
          <span className="badge badge-sm badge-outline">
            Managed by environment variables
          </span>
        </div>
      )}
      {data?.instances.map((instance) => (
        <div
          key={instance.id}
          className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-base-300 bg-base-200/35 p-3"
        >
          <Download className="size-4 text-primary" />
          <span className="font-medium">{instance.name}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-base-content/50">
            {instance.url}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => edit(instance)}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs w-14"
            onClick={() => test.mutate(instance.id)}
            disabled={test.isPending}
          >
            {test.isPending && test.variables === instance.id
              ? <span className="loading loading-spinner loading-xs" />
              : test.isSuccess && test.variables === instance.id
              ? (
                "OK"
              )
              : (
                "Test"
              )}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs text-error"
            aria-label={`Remove ${instance.name}`}
            onClick={() => remove.mutate(instance.id)}
            disabled={remove.isPending}
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      ))}
      {test.isError && (
        <p className="mt-1 text-xs text-error">{test.error.message}</p>
      )}

      {editing !== null && (
        <form
          className="mt-3 rounded-lg border border-primary/25 bg-primary/5 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <strong className="text-sm">
              {editing === "new"
                ? "Connect qBittorrent"
                : `Edit ${editing.name}`}
            </strong>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => setEditing(null)}
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="form-control">
              <span className="label-text text-xs">Name</span>
              <input
                className="input input-bordered input-sm"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </label>
            <label className="form-control">
              <span className="label-text text-xs">URL</span>
              <input
                className="input input-bordered input-sm"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                required
              />
            </label>
            <label className="form-control">
              <span className="label-text text-xs">
                Username{editing !== "new" && " (leave blank to keep)"}
              </span>
              <input
                className="input input-bordered input-sm"
                autoComplete="username"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                disabled={clearCredentials}
              />
            </label>
            <label className="form-control">
              <span className="label-text text-xs">
                Password{editing !== "new" && " (leave blank to keep)"}
              </span>
              <input
                type="password"
                className="input input-bordered input-sm"
                autoComplete="current-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                disabled={clearCredentials}
              />
            </label>
          </div>
          {editing !== "new" &&
            (editing.usernameConfigured || editing.passwordConfigured) && (
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="checkbox checkbox-xs"
                checked={clearCredentials}
                onChange={(event) => setClearCredentials(event.target.checked)}
              />
              Clear saved username and password and use authentication bypass
            </label>
          )}
          <p className="mt-2 text-xs text-base-content/50">
            Credentials may be left blank only when qBittorrent bypasses Web UI
            authentication for the Plex Librarian host or subnet.
          </p>
          {save.isError && (
            <p className="mt-2 text-xs text-error">{save.error.message}</p>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setEditing(null)}
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
      )}
    </section>
  );
}
