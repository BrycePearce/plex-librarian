import { createFileRoute, redirect, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ArrowLeft, ArrowDown, ArrowUp } from 'lucide-react'
import { api } from '../lib/api'
import type { StaleParams, StaleItem, SortKey } from '../lib/api'
import { formatBytes, formatDate } from '../lib/format'

export const Route = createFileRoute('/libraries/$key/stale')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: ['auth', 'status'],
      queryFn: api.auth.status,
      staleTime: 60_000,
    })
    if (!status.configured) throw redirect({ to: '/setup' })
  },
  component: StalePage,
})

const PAGE_SIZE = 50

function StalePage() {
  const { key } = Route.useParams()
  const [params, setParams] = useState<StaleParams>({
    days: 365,
    filter: 'all',
    sort: 'fileSize',
    order: 'desc',
    limit: PAGE_SIZE,
    offset: 0,
  })

  const { data, isLoading, isPlaceholderData } = useQuery({
    queryKey: ['stale', key, params],
    queryFn: () => api.libraries.stale(key, params),
    placeholderData: (prev) => prev,
  })

  const page = Math.floor((params.offset ?? 0) / PAGE_SIZE)
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0

  function setSort(sort: SortKey) {
    setParams((p) => ({
      ...p,
      sort,
      order: p.sort === sort && p.order === 'desc' ? 'asc' : 'desc',
      offset: 0,
    }))
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/dashboard" className="btn btn-ghost btn-sm gap-1">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Stale Items</h1>
          {data && (
            <p className="text-base-content/50 text-sm">
              {data.total.toLocaleString()} items · {formatBytes(pageFileSize(data.items))} on this page
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="form-control gap-1">
          <span className="label-text text-xs">Not viewed in</span>
          <select
            className="select select-bordered select-sm"
            value={params.days}
            onChange={(e) => setParams((p) => ({ ...p, days: Number(e.target.value), offset: 0 }))}
          >
            <option value={90}>3 months</option>
            <option value={180}>6 months</option>
            <option value={365}>1 year</option>
            <option value={730}>2 years</option>
            <option value={1095}>3 years</option>
          </select>
        </label>
        <label className="form-control gap-1">
          <span className="label-text text-xs">Filter</span>
          <select
            className="select select-bordered select-sm"
            value={params.filter}
            onChange={(e) =>
              setParams((p) => ({
                ...p,
                filter: e.target.value as StaleParams['filter'],
                offset: 0,
              }))
            }
          >
            <option value="all">All</option>
            <option value="watched">Watched</option>
            <option value="unwatched">Unwatched</option>
          </select>
        </label>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <span className="loading loading-spinner loading-lg" />
        </div>
      ) : (
        <div className={`overflow-x-auto transition-opacity ${isPlaceholderData ? 'opacity-50' : ''}`}>
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Title</th>
                <SortTh label="Size" field="fileSize" params={params} onSort={setSort} />
                <SortTh label="Last viewed" field="lastViewedAt" params={params} onSort={setSort} />
                <SortTh label="Added" field="addedAt" params={params} onSort={setSort} />
                <th>Plays</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((item) => <ItemRow key={item.ratingKey} item={item} />)}
            </tbody>
          </table>
          {data?.items.length === 0 && (
            <p className="text-center text-base-content/40 py-20">No stale items found.</p>
          )}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <button
            className="btn btn-sm"
            disabled={page === 0}
            onClick={() => setParams((p) => ({ ...p, offset: (page - 1) * PAGE_SIZE }))}
          >
            Previous
          </button>
          <span className="btn btn-sm btn-ghost no-animation pointer-events-none">
            {page + 1} / {totalPages}
          </span>
          <button
            className="btn btn-sm"
            disabled={page >= totalPages - 1}
            onClick={() => setParams((p) => ({ ...p, offset: (page + 1) * PAGE_SIZE }))}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}

function SortTh({
  label,
  field,
  params,
  onSort,
}: {
  label: string
  field: SortKey
  params: StaleParams
  onSort: (f: SortKey) => void
}) {
  const active = params.sort === field
  return (
    <th>
      <button
        className="flex items-center gap-1 hover:text-primary transition-colors"
        onClick={() => onSort(field)}
      >
        {label}
        {active
          ? params.order === 'desc'
            ? <ArrowDown className="w-3 h-3" />
            : <ArrowUp className="w-3 h-3" />
          : <span className="w-3 h-3 opacity-0"><ArrowDown className="w-3 h-3" /></span>
        }
      </button>
    </th>
  )
}

function ItemRow({ item }: { item: StaleItem }) {
  const thumbUrl = item.thumb
    ? `/api/proxy/thumb?path=${encodeURIComponent(item.thumb)}&width=60&height=90`
    : null

  return (
    <tr className="hover">
      <td>
        <div className="flex items-center gap-3">
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt=""
              className="w-10 h-14 object-cover rounded shrink-0 bg-base-300"
              loading="lazy"
            />
          ) : (
            <div className="w-10 h-14 rounded bg-base-300 shrink-0" />
          )}
          <div className="min-w-0">
            <div className="font-medium truncate max-w-xs">{item.title}</div>
            {item.year && <div className="text-xs text-base-content/40">{item.year}</div>}
          </div>
        </div>
      </td>
      <td className="text-sm font-mono whitespace-nowrap">
        {item.fileSize != null ? formatBytes(item.fileSize) : '—'}
      </td>
      <td className="text-sm text-base-content/70 whitespace-nowrap">
        {item.lastViewedAt
          ? formatDate(item.lastViewedAt)
          : <span className="badge badge-outline badge-sm">never</span>
        }
      </td>
      <td className="text-sm text-base-content/70 whitespace-nowrap">
        {item.addedAt ? formatDate(item.addedAt) : '—'}
      </td>
      <td className="text-sm font-mono">{item.viewCount ?? 0}</td>
    </tr>
  )
}

function pageFileSize(items: StaleItem[]): number {
  return items.reduce((sum, i) => sum + (i.fileSize ?? 0), 0)
}
