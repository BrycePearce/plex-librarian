import { createRootRouteWithContext, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { Library } from "lucide-react";
import { AppSidebar } from "../components/AppSidebar";
import { SyncCacheCoordinator } from "../features/sync/SyncCacheCoordinator";
import { DeletionOperationCoordinator } from "../features/deletionOperations/DeletionOperationCoordinator";
import { DisconnectTransitionProvider } from "../features/auth/DisconnectTransition";
import "./__root.css";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <DisconnectTransitionProvider>
      <RootLayout />
    </DisconnectTransitionProvider>
  ),
});

function RootLayout() {
  const isSetup = useRouterState({
    select: (state) => state.location.pathname.startsWith("/setup"),
  });

  if (isSetup) {
    return (
      <div className="h-screen flex flex-col bg-base-100 text-base-content overflow-hidden">
        <nav className="navbar bg-base-200 border-b border-base-300 px-4 shrink-0">
          <Link to="/dashboard" className="flex items-center gap-2 text-lg font-semibold">
            <Library className="w-5 h-5 text-primary" /> Plex Librarian
          </Link>
        </nav>
        <main className="scroll-area flex-1 overflow-y-auto">
          <div className="flex flex-col min-h-full container mx-auto px-4 py-8 max-w-6xl"><Outlet /></div>
        </main>
      </div>
    );
  }

  return (
    <DeletionOperationCoordinator>
      <div className="app-shell bg-base-100 text-base-content">
        <SyncCacheCoordinator />
        <AppSidebar />
        <main className="scroll-area app-main overflow-y-auto">
          <div className="flex flex-col min-h-full container mx-auto px-4 py-8 max-w-6xl">
            <div className="flex flex-col flex-1">
              <Outlet />
            </div>
          </div>
        </main>
        {import.meta.env.DEV && (
          <>
            <TanStackRouterDevtools />
            <ReactQueryDevtools />
          </>
        )}
      </div>
    </DeletionOperationCoordinator>
  );
}
