// Loading-state placeholders, one per real layout they stand in for. Each mirrors its
// counterpart's markup (grid/table shape, column widths) so nothing jumps when real
// content replaces it.

export function StatsStripSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="card bg-base-200">
          <div className="card-body flex-row items-center gap-4 py-4">
            <div className="skeleton w-10 h-10 rounded-lg shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="skeleton h-3 w-16" />
              {
                /* h-6, not h-5 — the real value line is text-xl (28px line-height); with
                  the 8px gap above, 24+8+12=44 matches the real stack's total height. */
              }
              <div className="skeleton h-6 w-20" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function LibraryCardSkeleton() {
  return (
    <div className="card bg-base-200">
      <div className="card-body gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="skeleton w-8 h-8 rounded-lg shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              {
                /* h-5, not h-4 — the real title line inherits a 24px line-height; with
                  the 8px gap and the 12px type line below, 20+8+12=40 matches the real
                  title+type stack's total height. */
              }
              <div className="skeleton h-5 w-3/4" />
              <div className="skeleton h-3 w-1/3" />
            </div>
          </div>
          <div className="skeleton w-6 h-6 rounded shrink-0" />
        </div>
        {/* h-4, not h-3 — the real line below is text-xs (16px line-height). */}
        <div className="skeleton h-4 w-1/2" />
      </div>
    </div>
  );
}

export function StaleTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="overflow-x-auto">
      <progress className="progress progress-primary w-full h-0.5 mb-1 opacity-0" />
      <table className="table table-sm table-fixed">
        <colgroup>
          <col className="w-8" />
          <col />
          <col className="w-24" />
          <col className="w-32" />
          <col className="w-32" />
          <col className="w-16" />
          <col className="w-10" />
        </colgroup>
        <thead>
          <tr>
            <th />
            <th>Title</th>
            <th>Size</th>
            <th>Last viewed</th>
            <th>Added</th>
            <th>Plays</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <tr key={i}>
              <td />
              <td>
                <div className="flex items-center gap-3">
                  <div className="skeleton w-10 h-14 rounded shrink-0" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="skeleton h-4 w-3/4" />
                    <div className="skeleton h-3 w-10" />
                  </div>
                </div>
              </td>
              <td>
                <div className="skeleton h-3 w-12" />
              </td>
              <td>
                <div className="skeleton h-3 w-20" />
              </td>
              <td>
                <div className="skeleton h-3 w-20" />
              </td>
              <td>
                <div className="skeleton h-3 w-6" />
              </td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ShowDetailSkeleton() {
  return (
    <>
      <div className="flex gap-6 items-start">
        <div className="skeleton w-24 h-36 rounded shrink-0" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-3 flex-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="skeleton h-3 w-16" />
              <div className="skeleton h-4 w-10" />
            </div>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th className="w-12">#</th>
              <th>Season</th>
              <th>Size</th>
              <th>Duration</th>
              <th>Episodes</th>
              <th>Plays</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 4 }).map((_, i) => (
              <tr key={i}>
                <td>
                  <div className="skeleton h-3 w-4" />
                </td>
                <td>
                  <div className="skeleton h-4 w-24" />
                </td>
                <td>
                  <div className="skeleton h-3 w-12" />
                </td>
                <td>
                  <div className="skeleton h-3 w-12" />
                </td>
                <td>
                  <div className="skeleton h-3 w-6" />
                </td>
                <td>
                  <div className="skeleton h-3 w-6" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function MovieDetailSkeleton() {
  return (
    <div className="flex gap-6 items-start">
      <div className="skeleton w-24 h-36 rounded shrink-0" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-3 flex-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="skeleton h-3 w-16" />
            <div className="skeleton h-4 w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="dashboard-loading space-y-6" aria-label="Loading dashboard">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="dashboard-stat-card dashboard-skeleton-stat">
            <div className="dashboard-stat-content">
              <span className="dashboard-skeleton-block size-11 rounded-[13px] shrink-0" />
              <span className="space-y-2 flex-1">
                <span className="dashboard-skeleton-block block h-2.5 w-16 rounded" />
                <span className="dashboard-skeleton-block block h-5 w-24 rounded" />
              </span>
            </div>
          </div>
        ))}
      </div>

      <section className="home-directory">
        <div className="dashboard-section-heading">
          <div>
            <span className="dashboard-section-kicker">Workspace</span>
            <h2>Explore Plex Librarian</h2>
          </div>
        </div>
        <div className="home-directory-list">
          <div className="home-stale-section home-collection-section dashboard-skeleton-collection">
            <div className="home-stale-heading">
              <span className="home-directory-index">01</span>
              <span className="dashboard-skeleton-block size-11 rounded-[13px]" />
              <span className="space-y-2">
                <span className="dashboard-skeleton-block block h-2 w-20 rounded" />
                <span className="dashboard-skeleton-block block h-4 w-28 rounded" />
              </span>
              <span className="dashboard-skeleton-block h-6 w-16 rounded-full" />
            </div>
            <div className="home-stale-libraries">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="home-stale-library dashboard-skeleton-library">
                  <span className="dashboard-skeleton-block size-8 rounded-lg" />
                  <span className="space-y-1.5">
                    <span className="dashboard-skeleton-block block h-2.5 w-20 rounded" />
                    <span className="dashboard-skeleton-block block h-2 w-28 max-w-full rounded" />
                  </span>
                </div>
              ))}
            </div>
          </div>
          {["02", "03"].map((index) => (
            <div key={index} className="home-directory-section dashboard-skeleton-directory-row">
              <span className="home-directory-index">{index}</span>
              <span className="dashboard-skeleton-block size-11 rounded-[13px]" />
              <span className="space-y-2">
                <span className="dashboard-skeleton-block block h-2 w-16 rounded" />
                <span className="dashboard-skeleton-block block h-4 w-24 rounded" />
              </span>
              <span className="dashboard-skeleton-block h-2.5 w-24 rounded" />
            </div>
          ))}
        </div>
      </section>

      <section className="dashboard-panel dashboard-skeleton-history">
        <div className="dashboard-panel-header">
          <div className="space-y-2">
            <span className="dashboard-section-kicker">Operations</span>
            <h2>Recent syncs</h2>
          </div>
        </div>
        <div className="sync-history-table">
          {Array.from({ length: 4 }).map((_, row) => (
            <div key={row} className="dashboard-skeleton-table-row">
              {Array.from({ length: 5 }).map((__, column) => (
                <span
                  key={column}
                  className={`dashboard-skeleton-block h-2.5 rounded ${
                    column === 1 ? "w-28" : "w-16"
                  }`}
                />
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function UsersTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="overflow-x-auto" aria-label="Loading users">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>User</th>
            <th>Last watched</th>
            <th>Sharing risk</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <tr key={i}>
              <td>
                <div className="flex items-center gap-3">
                  <div className="skeleton w-8 h-8 rounded-full shrink-0" />
                  <div className="space-y-2 min-w-0 flex-1">
                    <div className="skeleton h-4 w-28" />
                    <div className="skeleton h-3 w-40" />
                  </div>
                </div>
              </td>
              <td>
                <div className="skeleton h-3 w-20" />
              </td>
              <td>
                <div className="space-y-2">
                  <div className="skeleton h-5 w-24 rounded-full" />
                  <div className="skeleton h-3 w-20" />
                </div>
              </td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DuplicatesTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="overflow-x-auto" aria-label="Loading duplicate versions">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Title</th>
            <th>Versions</th>
            <th>Combined size</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <tr key={i}>
              <td>
                <div className="space-y-2">
                  <div className="skeleton h-4 w-48" />
                  <div className="skeleton h-3 w-24" />
                </div>
              </td>
              <td>
                <div className="skeleton h-5 w-20 rounded-full" />
              </td>
              <td>
                <div className="skeleton h-3 w-20" />
              </td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ActivityListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-label="Loading activity">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="card bg-base-200">
          <div className="card-body flex-row items-center gap-3 py-3">
            <div className="skeleton w-4 h-4 rounded-full shrink-0" />
            <div className="skeleton h-4 flex-1 max-w-md" />
            <div className="skeleton h-3 w-16 shrink-0" />
          </div>
        </div>
      ))}
    </div>
  );
}
