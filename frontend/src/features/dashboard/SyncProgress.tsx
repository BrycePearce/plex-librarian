import { useState } from "react";
import { motion } from "motion/react";
import { CheckCircle, ChevronDown, Library as LibraryGlyph } from "lucide-react";
import type { LibraryPhase, LibrarySyncProgress } from "../../lib/api.ts";
import { formatDuration } from "../../lib/format.ts";
import { useCountUp } from "./useCountUp.ts";

const PHASE_LABEL: Record<LibraryPhase, string> = {
  pending: "Waiting",
  items: "Syncing items",
  episodes: "Indexing episodes",
  tracks: "Indexing tracks",
  history: "Syncing history",
  done: "Done",
};

function LibraryProgressRow({ lib }: { lib: LibrarySyncProgress }) {
  const done = lib.phase === "done";
  const count = useCountUp(lib.count, 800, done);
  const pending = lib.phase === "pending";
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="w-4 shrink-0 flex items-center justify-center">
        {done
          ? <CheckCircle className="w-4 h-4 text-success" />
          : pending
          ? null
          : <span className="loading loading-spinner loading-xs" />}
      </div>
      <span
        className={`w-36 truncate font-medium ${pending ? "text-base-content/30" : ""}`}
      >
        {lib.title}
      </span>
      <span className="text-base-content/40 w-36">
        {PHASE_LABEL[lib.phase]}
        {lib.phase === "done" && lib.elapsedSeconds != null && (
          <span className="ml-1">· {formatDuration(lib.elapsedSeconds)}</span>
        )}
      </span>
      {!pending && (
        <span className="font-mono text-base-content/40 ml-auto">
          {count.toLocaleString()}
        </span>
      )}
    </div>
  );
}

export function FirstRunHero({ progress }: { progress?: LibrarySyncProgress[] }) {
  const totalItems = progress?.reduce((sum, l) => sum + l.count, 0) ?? 0;
  const animatedTotal = useCountUp(totalItems, 800);
  const doneCount = progress?.filter((l) => l.phase === "done").length ?? 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 26 }}
      className="card bg-base-200 shadow-xl"
    >
      <div className="card-body items-center text-center gap-6 py-14">
        <div className="w-14 h-14 rounded-2xl bg-primary/15 text-primary flex items-center justify-center">
          <LibraryGlyph className="w-7 h-7" />
        </div>
        <div className="flex flex-col gap-1">
          <h2 className="card-title text-2xl justify-center">
            Importing your libraries
          </h2>
          <p className="text-base-content/60 max-w-md">
            This first sync pulls everything from Plex, so it can take a few minutes on large
            libraries.
          </p>
        </div>

        {progress?.length
          ? (
            <div className="w-full max-w-sm flex flex-col gap-2.5 text-left">
              {progress.map((lib) => <LibraryProgressRow key={lib.key} lib={lib} />)}
              <div className="text-xs text-base-content/40 text-center pt-1">
                {doneCount} of {progress.length} libraries done · {animatedTotal.toLocaleString()}
                {" "}
                items so far
              </div>
            </div>
          )
          : <span className="loading loading-ring w-12 text-primary" />}
      </div>
    </motion.div>
  );
}

export function SyncProgressPanel(
  { progress, done }: { progress?: LibrarySyncProgress[]; done?: boolean },
) {
  const [expanded, setExpanded] = useState(false);
  const totalItems = progress?.reduce((sum, l) => sum + l.count, 0) ?? 0;
  const animatedTotal = useCountUp(totalItems, 800, done);

  if (!progress?.length) {
    return (
      <div className="alert">
        <span className="loading loading-spinner loading-sm" />
        <span>Sync starting…</span>
      </div>
    );
  }

  const doneCount = progress.filter((l) => l.phase === "done").length;
  const isSingle = progress.length === 1;

  return (
    <div className="card bg-base-200">
      <div className="card-body gap-0 p-0">
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-3 rounded-box px-8 py-3 text-left text-sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          {done
            ? <CheckCircle className="w-4 h-4 text-success shrink-0" />
            : <span className="loading loading-spinner loading-xs shrink-0" />}
          <span className="font-medium flex-1">
            {done
              ? isSingle ? `${progress[0].title} synced` : `Synced ${progress.length} libraries`
              : isSingle
              ? `${progress[0].title} — ${PHASE_LABEL[progress[0].phase]}`
              : `Syncing ${progress.length} libraries`}
          </span>
          {!isSingle && !done && (
            <span className="text-base-content/40 text-xs">
              {doneCount} of {progress.length} done
            </span>
          )}
          <span className="font-mono text-base-content/40 text-xs">
            {animatedTotal.toLocaleString()} items
          </span>
          <ChevronDown
            className={`w-4 h-4 text-base-content/40 transition-transform duration-200 ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </button>

        {expanded && (
          <div className="mx-8 mb-3 flex flex-col gap-2 border-t border-base-300 pt-3">
            {progress.map((lib) => <LibraryProgressRow key={lib.key} lib={lib} />)}
          </div>
        )}
      </div>
    </div>
  );
}
