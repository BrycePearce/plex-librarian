import { createFileRoute, redirect, Link } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, Check } from 'lucide-react'
import { api } from '../lib/api'

export const Route = createFileRoute('/settings')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: ['auth', 'status'],
      queryFn: api.auth.status,
      staleTime: 60_000,
    })
    if (!status.configured) throw redirect({ to: '/setup' })
  },
  component: SettingsPage,
})

function SettingsPage() {
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings.get })

  return (
    <div className="space-y-6 max-w-md">
      <div className="flex items-center gap-4">
        <Link to="/dashboard" className="btn btn-ghost btn-sm gap-1">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      <div className="card bg-base-200">
        <div className="card-body gap-4">
          <div className="space-y-3">
            <div>
              <h2 className="font-medium">Default grace period for new items</h2>
              <p className="text-sm text-base-content/40 mt-0.5">
                Unwatched items added within this many days are not considered stale.
                Libraries without their own override use this default.
              </p>
            </div>
            {data ? (
              <GracePeriodInput initialDays={data.staleMinAgeDays} />
            ) : (
              <input
                type="number"
                className="input input-bordered input-sm w-24"
                disabled
                aria-label="Loading default grace period"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Only rendered once `data` has loaded (see SettingsPage above), so local editing state
// can be initialized directly from the server value on mount — no Effect syncing data
// into state, and so no frame where "not loaded yet" could be misread as "invalid".
function GracePeriodInput({ initialDays }: { initialDays: number }) {
  const qc = useQueryClient()
  const [staleMinAgeDays, setStaleMinAgeDays] = useState(String(initialDays))
  const lastSavedRef = useRef(initialDays)

  const [justSaved, setJustSaved] = useState(false)
  const savedTimeoutRef = useRef<number | undefined>(undefined)

  const update = useMutation({
    mutationFn: (value: number) => api.settings.update(value),
    onSuccess: (updated) => {
      qc.setQueryData(['settings'], updated)
      lastSavedRef.current = updated.staleMinAgeDays
      setJustSaved(true)
      clearTimeout(savedTimeoutRef.current)
      savedTimeoutRef.current = setTimeout(() => setJustSaved(false), 2000)
    },
  })

  useEffect(() => () => clearTimeout(savedTimeoutRef.current), [])

  const parsed = Number(staleMinAgeDays)
  const valid = staleMinAgeDays !== '' && Number.isInteger(parsed) && parsed >= 0

  // Debounced auto-save: waits for typing to settle so we don't PATCH on every keystroke.
  useEffect(() => {
    if (!valid || parsed === lastSavedRef.current) return
    const timer = setTimeout(() => update.mutate(parsed), 500)
    return () => clearTimeout(timer)
  }, [staleMinAgeDays, valid, parsed])

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={0}
        step={1}
        className={`input input-bordered input-sm w-24 ${!valid ? 'input-error' : ''}`}
        value={staleMinAgeDays}
        onChange={(e) => setStaleMinAgeDays(e.target.value)}
      />
      <span className="text-sm text-base-content/40">days</span>
      {update.isPending && <span className="loading loading-spinner loading-xs text-base-content/40" />}
      <span
        className={`flex items-center gap-1 text-xs text-success transition-opacity duration-300 ${
          justSaved && !update.isPending ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <Check className="w-3.5 h-3.5" /> Saved
      </span>
      {update.isError && (
        <span className="text-xs text-error">
          {update.error instanceof Error ? update.error.message : 'Failed to save'}
        </span>
      )}
    </div>
  )
}
