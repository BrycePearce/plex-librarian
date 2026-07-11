import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

const router = createRouter({
  routeTree,
  context: { queryClient },
  // Every route's `beforeLoad` awaits a network round-trip (the auth-status check) before
  // anything renders. Without this, that wait shows a blank page — most visible on a hard
  // refresh or a session's first navigation, since the check is cached for 60s afterward.
  // `flex-1` (not `min-h-screen`) so it fills whatever space `<main>` actually has below the
  // navbar — `min-h-screen` here centered against a box starting below the nav, not the
  // true viewport, landing the spinner well below true center.
  defaultPendingComponent: () => (
    <div className="flex-1 flex items-center justify-center">
      <span className="loading loading-spinner loading-lg text-primary" />
    </div>
  ),
  // Fast auth checks should feel instant, not flash a loader between two fully-rendered
  // pages. If navigation really does block, keep the fallback visible long enough that
  // it reads as intentional rather than a flicker.
  defaultPendingMs: 200,
  defaultPendingMinMs: 300,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
