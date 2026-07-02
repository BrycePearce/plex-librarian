// Loading-state placeholders, one per real layout they stand in for. Each mirrors its
// counterpart's markup (grid/table shape, column widths) so nothing jumps when real
// content replaces it.

export function LibraryCardSkeleton() {
  return (
    <div className="card bg-base-200">
      <div className="card-body gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="skeleton w-8 h-8 rounded-lg shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="skeleton h-4 w-3/4" />
              <div className="skeleton h-3 w-1/3" />
            </div>
          </div>
          <div className="skeleton w-6 h-6 rounded shrink-0" />
        </div>
        <div className="skeleton h-3 w-1/2" />
      </div>
    </div>
  )
}

export function StaleTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm table-fixed">
        <colgroup>
          <col />
          <col className="w-24" />
          <col className="w-32" />
          <col className="w-32" />
          <col className="w-16" />
        </colgroup>
        <thead>
          <tr>
            <th>Title</th>
            <th>Size</th>
            <th>Last viewed</th>
            <th>Added</th>
            <th>Plays</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <tr key={i}>
              <td>
                <div className="flex items-center gap-3">
                  <div className="skeleton w-10 h-14 rounded shrink-0" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="skeleton h-4 w-3/4" />
                    <div className="skeleton h-3 w-10" />
                  </div>
                </div>
              </td>
              <td><div className="skeleton h-3 w-12" /></td>
              <td><div className="skeleton h-3 w-20" /></td>
              <td><div className="skeleton h-3 w-20" /></td>
              <td><div className="skeleton h-3 w-6" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
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
                <td><div className="skeleton h-3 w-4" /></td>
                <td><div className="skeleton h-4 w-24" /></td>
                <td><div className="skeleton h-3 w-12" /></td>
                <td><div className="skeleton h-3 w-12" /></td>
                <td><div className="skeleton h-3 w-6" /></td>
                <td><div className="skeleton h-3 w-6" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
