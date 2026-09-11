import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DockerStoragePreview } from "../../../../shared/serviceStorage.ts";
import { api } from "../../lib/api.ts";

/** Imports a bounded, credential-free host report; never requests Docker socket access. */
export function DockerStorageSetup() {
  const qc = useQueryClient();
  const [report, setReport] = useState("");
  const [preview, setPreview] = useState<DockerStoragePreview>();
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [fileError, setFileError] = useState<string>();
  const [copyStatus, setCopyStatus] = useState<string>();
  const [selections, setSelections] = useState<Record<string, string>>({});
  const revision = useRef(0);
  const origin = typeof location === "undefined" ? "<Librarian URL>" : location.origin;
  const hostCommand =
    `curl -fsS '${origin}/api/settings/service-storage/docker-report.sh' -o librarian-docker-report.sh && sh librarian-docker-report.sh > librarian-docker-report.json && cat librarian-docker-report.json`;
  const check = useMutation({
    mutationFn: (input: { report: string; revision: number; selections: Record<string, string> }) =>
      api.serviceStorage.dockerPreview(input.report, input.selections),
    onSuccess: (data, input) => {
      if (input.revision === revision.current) setPreview(data);
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api.serviceStorage.dockerConfirm({
        report,
        fingerprint: preview!.fingerprint!,
        confirmed: true,
        selections,
        ...(replaceExisting ? { replaceExisting: true } : {}),
      }),
    onSuccess: (data) => qc.setQueryData(["service-storage"], data),
  });
  function changeReport(value: string) {
    revision.current++;
    setReport(value);
    setPreview(undefined);
    setReplaceExisting(false);
    setSelections({});
    setFileError(undefined);
    check.reset();
    save.reset();
  }
  return (
    <div className="rounded-lg border border-base-300 p-3 space-y-3">
      <h4 className="font-semibold">Check Docker storage mappings</h4>
      <p className="text-sm">
        Run the read-only report on your Unraid or Docker host, then import its output below.
        Librarian matches your connected services and checks their container mounts to create the
        relationships together. No media mount or Docker socket access is needed. Native Linux
        Docker hosts are supported, including Unraid; Docker Desktop is not supported.
      </p>
      <p className="text-sm">
        Open the Unraid Terminal or Docker host shell and run this command. Copy its JSON output and
        paste it below, or upload the generated report file:
      </p>
      <pre className="text-xs whitespace-pre-wrap break-all bg-base-200 p-2 rounded">{hostCommand}</pre>
      <button
        type="button"
        className="btn btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(hostCommand);
            setCopyStatus("Command copied.");
          } catch {
            setCopyStatus("Select and copy the command above.");
          }
        }}
      >
        Copy host command
      </button>
      {copyStatus && <p role="status" className="text-sm">{copyStatus}</p>}
      <p className="text-sm">
        <a className="link" href="/api/settings/service-storage/docker-report.sh" download>
          Download or inspect the report script
        </a>{" "}
        if you prefer to run it separately. The report contains container and host identifiers,
        network addresses, and mount paths; it excludes service credentials and environment
        variables.
      </p>
      <label className="block text-sm">
        Import report file
        <input
          type="file"
          accept=".json,application/json"
          className="file-input file-input-sm block w-full mt-1"
          disabled={save.isPending}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const currentRevision = ++revision.current;
            setPreview(undefined);
            if (file.size > 2_000_000) {
              setFileError("This report is too large. Import the filtered report from the script.");
              return;
            }
            try {
              const value = await file.text();
              if (revision.current === currentRevision) changeReport(value);
            } catch {
              if (revision.current === currentRevision) setFileError("Could not read this file.");
            }
          }}
        />
      </label>
      <label className="block text-sm">
        Or paste report JSON
        <textarea
          className="textarea w-full font-mono mt-1"
          rows={4}
          value={report}
          disabled={save.isPending}
          onChange={(event) => changeReport(event.target.value)}
        />
      </label>
      {fileError && <p role="alert">{fileError}</p>}
      <button
        type="button"
        className="btn btn-sm"
        disabled={!report.trim() || check.isPending || save.isPending || !!fileError}
        onClick={() => {
          setPreview(undefined);
          setReplaceExisting(false);
          save.reset();
          check.mutate({ report, revision: revision.current, selections });
        }}
      >
        {check.isPending ? "Checking mappings…" : "Check report"}
      </button>
      {check.error && <p role="alert">Could not check the report: {check.error.message}</p>}
      {preview && (
        <div className="space-y-2">
          {preview.reason && <p role="status">{preview.reason}</p>}
          <ul className="text-sm space-y-2">
            {preview.services.map((service) => (
              <li key={service.serviceKey}>
                <strong>{service.name}</strong>
                {service.containerName && <>→ {service.containerName}</>}
                {service.matchedBy && (
                  <span className="text-xs">
                    {service.matchedBy === "address"
                      ? " · Matched by connection address"
                      : " · Container selected by you"}
                  </span>
                )}
                {!!service.candidates?.length && (
                  <label className="block">
                    Which container serves this connection?
                    <select
                      className="select select-sm block"
                      value={selections[service.serviceKey] ?? ""}
                      disabled={save.isPending || check.isPending}
                      onChange={(event) => {
                        const next = { ...selections, [service.serviceKey]: event.target.value };
                        if (!event.target.value) delete next[service.serviceKey];
                        setSelections(next);
                        setReplaceExisting(false);
                        save.reset();
                        // A changed match is never eligible to save before a new backend check.
                        setPreview({ ...preview, fingerprint: undefined });
                      }}
                    >
                      <option value="">Choose container</option>
                      {service.candidates.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                {service.reason
                  ? <p>{service.reason}</p>
                  : service.roots.map((root) => (
                    <p key={root.serviceRoot} className="break-all">
                      <code>{root.serviceRoot}</code> → host{" "}
                      <code>{root.storageRoot.replace(/^\/docker\/[^/]+(?=\/)/, "")}</code>
                    </p>
                  ))}
              </li>
            ))}
          </ul>
          <p className="text-xs">
            These checks use the reported Docker mappings, not a filesystem inspection or ongoing
            connection to Docker. Import a fresh report after changing containers or mounts.
            Deletion previews still check current media and retained content.
          </p>
          {!!preview.invalidatedServices?.length && (
            <div role="status" className="text-warning text-sm">
              <p>
                Previous mappings for {preview.invalidatedServices.map((service) =>
                  service.name
                ).join(", ")}{" "}
                will be removed. Deletion through these services remains unavailable until checked
                again.
              </p>
            </div>
          )}
          {preview.replacementRequired && (
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={replaceExisting}
                disabled={save.isPending}
                onChange={(event) => setReplaceExisting(event.target.checked)}
              />Replace existing relationships with these reported mappings
              {preview.invalidatedServices?.length
                ? " and remove the previous mappings listed above."
                : "."}
            </label>
          )}
          {preview.status !== "unavailable" && preview.fingerprint && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={save.isPending || save.isError ||
                (preview.replacementRequired && !replaceExisting)}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving setup…" : "Save checked mappings"}
            </button>
          )}
        </div>
      )}
      {save.error && (
        <p role="alert">
          Setup was not saved: {save.error.message} Check the report again before saving.
        </p>
      )}
      {save.isSuccess && <p role="status">Reported mappings saved.</p>}
    </div>
  );
}
