import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Film, Plus, Search, Trash2, Tv, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { IgnoredContentItem, IgnoredContentResponse } from "@shared/types";
import { PosterThumb } from "../../components/PosterThumb.tsx";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";

const affectedQueryKeys = [
  queryKeys.libraries.all,
  queryKeys.stale.all,
  queryKeys.staleQuickCleanup.all,
  queryKeys.show.all,
  queryKeys.movie.all,
  queryKeys.duplicates.all,
  queryKeys.users.all,
  queryKeys.episodeGaps.all,
  queryKeys.downloadCleanupPreview.all,
  queryKeys.versionDeletionPreview.all,
] as const;

export function IgnoredContentManager() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const ignored = useQuery({
    queryKey: queryKeys.settings.ignoredContent,
    queryFn: api.settings.ignoredContent,
  });
  const search = useQuery({
    queryKey: queryKeys.settings.ignoredContentSearch(debouncedQuery),
    queryFn: () => api.settings.searchIgnoredContent(debouncedQuery),
    enabled: debouncedQuery.length >= 2,
    // Do not blank the list while a new query is in flight. Keeping the last
    // result set in place is much calmer than flashing through an empty state.
    placeholderData: (previous) => previous,
  });

  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => globalThis.clearTimeout(timer);
  }, [query]);

  async function refreshResults() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.ignoredContent }),
      queryClient.invalidateQueries({
        queryKey: ["settings", "ignored-content", "search"],
      }),
      ...affectedQueryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    ]);
  }

  const add = useMutation({
    mutationFn: api.settings.addIgnoredContent,
    onSuccess: async (item) => {
      queryClient.setQueryData<IgnoredContentResponse>(
        queryKeys.settings.ignoredContent,
        (current) => ({
          items: [
            ...(current?.items.filter(({ ratingKey }) => ratingKey !== item.ratingKey) ?? []),
            item,
          ]
            .sort((a, b) => a.title.localeCompare(b.title)),
        }),
      );
      setQuery("");
      setDebouncedQuery("");
      await refreshResults();
    },
  });
  const remove = useMutation({
    mutationFn: api.settings.removeIgnoredContent,
    onSuccess: async (_, ratingKey) => {
      queryClient.setQueryData<IgnoredContentResponse>(
        queryKeys.settings.ignoredContent,
        (current) => ({
          items: current?.items.filter((item) => item.ratingKey !== ratingKey) ?? [],
        }),
      );
      await refreshResults();
    },
  });
  const busyKey = add.isPending ? add.variables : remove.isPending ? remove.variables : null;
  const count = ignored.data?.items.length ?? 0;
  const normalizedQuery = query.trim();
  const searchMode = normalizedQuery.length >= 2;
  const searchUpdating = searchMode &&
    (normalizedQuery !== debouncedQuery || search.isFetching);

  return (
    <>
      <button
        type="button"
        className="btn btn-outline btn-sm"
        onClick={() => dialogRef.current?.showModal()}
      >
        Manage ignored content
        {count > 0 && <span className="badge badge-sm badge-primary">{count}</span>}
      </button>
      <dialog
        id="ignored-content-manager"
        ref={dialogRef}
        className="modal"
        onClose={() => {
          setQuery("");
          setDebouncedQuery("");
          add.reset();
          remove.reset();
        }}
      >
        <div className="modal-box polished-modal flex h-[min(44rem,88dvh)] max-w-3xl flex-col p-0">
          <header className="flex items-start gap-3 border-b border-base-content/10 p-6 pb-5">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-primary/15 bg-primary/10 text-primary">
              <Search className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold tracking-tight">Ignored content</h2>
              <p className="mt-1 text-sm leading-relaxed text-base-content/55">
                Movies and shows added here stay synced, but are excluded from insights, cleanup
                tools, totals, and detail pages.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-square"
              onClick={() => dialogRef.current?.close()}
              aria-label="Close ignored content manager"
            >
              <X className="size-4" />
            </button>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-5 p-6">
            <label className="input input-bordered flex w-full items-center gap-2">
              <Search className="size-4 text-base-content/40" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="grow"
                placeholder="Search synced movies and shows…"
                autoFocus
              />
              {searchUpdating && <span className="loading loading-spinner loading-xs" />}
              {query.length > 0 && !searchUpdating && (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs btn-circle -mr-1 text-base-content/45"
                  onClick={() => {
                    setQuery("");
                    setDebouncedQuery("");
                  }}
                  aria-label="Clear search"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </label>

            <div className="relative min-h-0 flex-1">
              <AnimatePresence initial={false}>
                {searchMode
                  ? (
                    <ContentList
                      key="search"
                      title={`Search results${search.data ? ` (${search.data.items.length})` : ""}`}
                      items={search.data?.items ?? []}
                      empty={search.isPending ? "Searching…" : "No matching movies or shows."}
                      busyKey={busyKey}
                      updating={searchUpdating}
                      action={(item) =>
                        item.ignored
                          ? <span className="badge badge-sm badge-ghost">Ignored</span>
                          : (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={() => add.mutate(item.ratingKey)}
                              disabled={busyKey !== null}
                            >
                              <Plus className="size-3.5" /> Ignore
                            </button>
                          )}
                    />
                  )
                  : (
                    <ContentList
                      key="ignored"
                      title={`Currently ignored${count > 0 ? ` (${count})` : ""}`}
                      items={ignored.data?.items ?? []}
                      empty={ignored.isPending
                        ? "Loading ignored content…"
                        : "Nothing is currently ignored."}
                      busyKey={busyKey}
                      action={(item) => (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm text-error"
                          onClick={() => remove.mutate(item.ratingKey)}
                          disabled={busyKey !== null}
                        >
                          <Trash2 className="size-3.5" /> Remove
                        </button>
                      )}
                    />
                  )}
              </AnimatePresence>
            </div>

            {(add.error || remove.error || ignored.error || search.error) && (
              <div className="alert alert-error text-sm">
                {(add.error || remove.error || ignored.error || search.error)?.message}
              </div>
            )}
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button type="submit">Close</button>
        </form>
      </dialog>
    </>
  );
}

function ContentList({
  title,
  items,
  empty,
  busyKey,
  updating = false,
  action,
}: {
  title: string;
  items: IgnoredContentItem[];
  empty: string;
  busyKey: string | null;
  updating?: boolean;
  action: (item: IgnoredContentItem) => ReactNode;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.section
      className="absolute inset-0 flex min-h-0 flex-col"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.09, ease: "easeOut" }}
    >
      <h3 className="mb-2 shrink-0 text-xs font-bold uppercase tracking-wider text-base-content/45">
        {title}
      </h3>
      <div
        className={`min-h-0 flex-1 rounded-xl border border-base-content/10 bg-base-200/25 ${
          items.length > 0 && !updating ? "overflow-y-auto" : "overflow-hidden"
        }`}
        aria-busy={updating}
        aria-live="polite"
      >
        {items.length === 0
          ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-5 text-center text-sm text-base-content/45">
              {empty}
            </div>
          )
          : items.map((item) => (
            <div
              key={item.ratingKey}
              className="flex items-center gap-3 border-b border-base-content/8 p-3 last:border-b-0"
            >
              <PosterThumb thumb={item.thumb} width={72} height={108} className="h-14 w-10" />
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm">{item.title}</strong>
                <small className="mt-0.5 flex items-center gap-1.5 text-base-content/45">
                  {item.type === "movie" ? <Film className="size-3" /> : <Tv className="size-3" />}
                  {item.type === "movie" ? "Movie" : "Show"}
                  {item.year ? ` · ${item.year}` : ""} · {item.libraryTitle}
                </small>
              </span>
              <span className="shrink-0">
                {busyKey === item.ratingKey
                  ? <span className="loading loading-spinner loading-sm mx-4" />
                  : action(item)}
              </span>
            </div>
          ))}
      </div>
    </motion.section>
  );
}
