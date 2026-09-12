import type { DeletionOperationTarget } from "@shared/types";

export function ServiceDeletionOutcomes({ outcomes }: {
  outcomes: DeletionOperationTarget["serviceOutcomes"];
}) {
  if (!outcomes?.length) return null;
  const groups = new Map<string, { outcome: typeof outcomes[number]; count: number }>();
  for (const outcome of outcomes) {
    const key = JSON.stringify([outcome.service, outcome.action, outcome.status]);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { outcome, count: 1 });
  }
  return (
    <div>
      {[...groups].map(([key, { outcome, count }]) => (
        <p key={key} className="text-sm mt-1">
          {outcome.service}: {outcome.action}
          {count > 1 ? ` (${count} outcomes)` : ""} — {outcome.status === "accepted"
            ? "request accepted"
            : outcome.status === "succeeded"
            ? "service reported success"
            : outcome.status === "reconciled"
            ? "absence covered by a recorded service response; no additional file deletion sent"
            : outcome.status === "failed"
            ? "request failed"
            : "outcome uncertain"}
        </p>
      ))}
      <details className="mt-2 text-xs text-base-content/55">
        <summary className="cursor-pointer">Advanced service evidence</summary>
        {outcomes.map((outcome, index) => (
          <p key={index} className="mt-1">
            {outcome.service}: {outcome.action} · {outcome.status}
            {outcome.httpStatus ? ` · HTTP ${outcome.httpStatus}` : ""}
            {outcome.error ? ` · ${outcome.error}` : ""}
          </p>
        ))}
      </details>
    </div>
  );
}
