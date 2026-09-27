import { createFileRoute } from "@tanstack/react-router";
import { DashboardPage } from "../features/dashboard/DashboardPage.tsx";
import { requireAuth } from "../lib/requireAuth.ts";
import "./dashboard.css";

export const Route = createFileRoute("/dashboard")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: DashboardPage,
});
