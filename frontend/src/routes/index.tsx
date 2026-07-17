import { createFileRoute, redirect } from '@tanstack/react-router'
import { api } from '../lib/api'
import { queryKeys } from '../lib/queryKeys'

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: queryKeys.auth.status,
      queryFn: api.auth.status,
    })
    throw redirect({ to: status.configured ? '/dashboard' : '/setup' })
  },
  component: () => null,
})
