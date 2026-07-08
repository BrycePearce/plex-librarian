import {
  createRootRouteWithContext,
  Link,
  Outlet,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { Library } from "lucide-react";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { UserMenu } from "../components/UserMenu";
import "./__root.css";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="h-screen flex flex-col bg-base-100 text-base-content overflow-hidden">
      <nav className="navbar bg-base-200 border-b border-base-300 px-4 shrink-0">
        <div className="flex-1">
          <Link
            to="/dashboard"
            className="flex items-center gap-2 text-lg font-semibold"
          >
            <Library className="w-5 h-5 text-primary" />
            Plex Librarian
          </Link>
        </div>
        <div className="flex items-center gap-1">
          <ThemeSwitcher />
          <UserMenu />
        </div>
      </nav>
      <main className="scroll-area flex-1 overflow-y-auto">
        <div className="flex flex-col container mx-auto px-4 py-8 max-w-6xl">
          <Outlet />
        </div>
      </main>
      {import.meta.env.DEV && (
        <>
          <TanStackRouterDevtools />
          <ReactQueryDevtools />
        </>
      )}
    </div>
  );
}
