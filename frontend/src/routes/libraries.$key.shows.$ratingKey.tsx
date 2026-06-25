import { createFileRoute, redirect, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { api } from '../lib/api'
import { formatKilobytes, formatDate, formatDuration } from '../lib/format'
import type { Season } from '../lib/api'

export const Route = createFileRoute('/libraries/$key/shows/$ratingKey')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: ['auth', 'status'],
      queryFn: api.auth.status,
      staleTime: 60_000,
    })
    if (!status.configured) throw redirect({ to: '/setup' })
  },
  component: ShowDetailPage,
})

function ShowDetailPage() {
  const { key, ratingKey } = Route.useParams()

  const { data, isLoading } = useQuery({
    queryKey: ['show', key, ratingKey],
    queryFn: () => api.libraries.showDetail(key, ratingKey),
  })

  const show = data?.show

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/libraries/$key/stale" params={{ key }} className="btn btn-ghost btn-sm gap-1">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div>
          <h1 className="text-2xl font-bold">{show?.title ?? '…'}</h1>
          {show?.year && <p className="text-base-content/50 text-sm">{show.year}</p>}
        </div>
      </div>

      {isLoading && (
        <div className="flex justify-center py-20">
          <span className="loading loading-spinner loading-lg" />
        </div>
      )}

      {data && (
        <>
          <div className="flex gap-6 items-start">
            {show?.thumb ? (
              <img
                src={`/api/proxy/thumb?path=${encodeURIComponent(show.thumb)}&width=120&height=180`}
                alt=""
                className="w-24 h-36 object-cover rounded bg-base-300 shrink-0"
              />
            ) : (
              <div className="w-24 h-36 rounded bg-base-300 shrink-0" />
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-3">
              <Stat label="Total size" value={show?.fileSize != null ? formatKilobytes(show.fileSize) : '—'} />
              <Stat label="Seasons" value={String(data.seasons.length)} />
              <Stat label="Last viewed" value={show?.lastViewedAt ? formatDate(show.lastViewedAt) : 'Never'} />
              <Stat label="Plays" value={String(show?.viewCount ?? 0)} />
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
                {data.seasons.map((season) => (
                  <SeasonRow key={season.ratingKey} season={season} />
                ))}
              </tbody>
            </table>
            {data.seasons.length === 0 && (
              <p className="text-center text-base-content/40 py-12">
                No season data yet — run a sync to populate sizes.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-base-content/40">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  )
}

function SeasonRow({ season }: { season: Season }) {
  return (
    <tr>
      <td className="text-base-content/40 font-mono text-sm">{season.seasonIndex}</td>
      <td className="font-medium">{season.title}</td>
      <td className="text-sm font-mono whitespace-nowrap">
        {season.fileSize != null ? formatKilobytes(season.fileSize) : '—'}
      </td>
      <td className="text-sm text-base-content/70 whitespace-nowrap">
        {season.duration != null ? formatDuration(Math.floor(season.duration / 1000)) : '—'}
      </td>
      <td className="text-sm font-mono">{season.leafCount ?? 0}</td>
      <td className="text-sm font-mono">{season.viewCount ?? 0}</td>
    </tr>
  )
}
