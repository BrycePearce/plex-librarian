import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, skipToken } from '@tanstack/react-query'
import { Server } from 'lucide-react'
import { api } from '../lib/api'
import type { PlexServer } from '../lib/api'

export const Route = createFileRoute('/setup')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: ['auth', 'status'],
      queryFn: api.auth.status,
    })
    if (status.configured) throw redirect({ to: '/dashboard' })
  },
  component: SetupPage,
})

type Step = 'initial' | 'polling' | 'pick-server'

function SetupPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [step, setStep] = useState<Step>('initial')
  const [pinId, setPinId] = useState<number | null>(null)
  const [pinCode, setPinCode] = useState('')
  const [pinExpired, setPinExpired] = useState(false)
  const [servers, setServers] = useState<PlexServer[]>([])

  const createPin = useMutation({
    mutationFn: () => api.auth.createPin(),
    onSuccess: (data) => {
      setPinId(data.pinId)
      setPinCode(data.code)
      setPinExpired(false)
      window.open(data.authUrl, '_blank', 'noopener,noreferrer')
      setStep('polling')
    },
  })

  useEffect(() => {
    if (step !== 'polling') return
    const timer = setTimeout(() => setPinExpired(true), 5 * 60 * 1000)
    return () => clearTimeout(timer)
  }, [step])

  const { data: pollData } = useQuery({
    queryKey: ['auth', 'pin', pinId],
    queryFn: step === 'polling' && pinId !== null && !pinExpired
      ? () => api.auth.pollPin(pinId)
      : skipToken,
    refetchInterval: 2_000,
  })

  useEffect(() => {
    if (pollData?.status === 'complete') {
      setServers(pollData.servers)
      setStep('pick-server')
    }
  }, [pollData])

  const chooseServer = useMutation({
    mutationFn: ({ server, uri }: { server: PlexServer; uri: string }) =>
      api.auth.chooseServer(uri, server.accessToken),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['auth', 'status'] })
      void navigate({ to: '/dashboard' })
    },
  })

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-4rem)]">
      {step === 'initial' && (
        <div className="card bg-base-200 shadow-xl w-full max-w-md">
          <div className="card-body items-center text-center gap-6">
            <h1 className="card-title text-3xl">Welcome</h1>
            <p className="text-base-content/60">
              Sign in with Plex to get started. We'll need read access to your server to
              track library health.
            </p>
            <button
              className="btn btn-primary btn-lg w-full"
              onClick={() => createPin.mutate()}
              disabled={createPin.isPending}
            >
              {createPin.isPending
                ? <span className="loading loading-spinner" />
                : 'Sign in with Plex'
              }
            </button>
            {createPin.isError && (
              <div className="alert alert-error text-sm">
                {createPin.error.message}
              </div>
            )}
          </div>
        </div>
      )}

      {step === 'polling' && (
        <div className="card bg-base-200 shadow-xl w-full max-w-md">
          <div className="card-body items-center text-center gap-6">
            <h2 className="card-title text-2xl">Authorize in Plex</h2>
            {pinExpired ? (
              <>
                <div className="alert alert-warning text-sm">
                  PIN expired. Start over to get a new one.
                </div>
              </>
            ) : (
              <>
                <p className="text-base-content/60">
                  Complete sign-in in the Plex tab that just opened. Your PIN:
                </p>
                <div className="font-mono text-5xl font-bold tracking-widest text-primary">
                  {pinCode}
                </div>
                <span className="loading loading-dots loading-lg text-primary" />
              </>
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setStep('initial'); setPinId(null) }}
            >
              Start over
            </button>
          </div>
        </div>
      )}

      {step === 'pick-server' && (
        <div className="card bg-base-200 shadow-xl w-full max-w-md">
          <div className="card-body gap-4">
            <h2 className="card-title text-2xl">Choose your server</h2>
            <p className="text-base-content/60 text-sm">
              Select the Plex Media Server you want to monitor.
            </p>
            <div className="flex flex-col gap-2">
              {servers.map((server) => {
                const bestConn = server.connections[0]
                if (!bestConn) return null
                return (
                  <button
                    key={`${server.name}:${bestConn.uri}`}
                    className="btn btn-outline justify-start gap-3 h-auto py-3"
                    onClick={() => chooseServer.mutate({ server, uri: bestConn.uri })}
                    disabled={chooseServer.isPending}
                  >
                    <Server className="w-5 h-5 shrink-0" />
                    <div className="text-left min-w-0">
                      <div className="font-semibold">{server.name}</div>
                      <div className="text-xs text-base-content/50 truncate">{bestConn.uri}</div>
                    </div>
                    {bestConn.local && (
                      <span className="badge badge-success badge-sm ml-auto shrink-0">local</span>
                    )}
                    {!bestConn.local && bestConn.relay && (
                      <span className="badge badge-warning badge-sm ml-auto shrink-0">relay</span>
                    )}
                  </button>
                )
              })}
              {servers.length === 0 && (
                <p className="text-base-content/40 text-sm text-center py-4">
                  No servers found on this account.
                </p>
              )}
            </div>
            {chooseServer.isError && (
              <div className="alert alert-error text-sm">
                {chooseServer.error.message}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
