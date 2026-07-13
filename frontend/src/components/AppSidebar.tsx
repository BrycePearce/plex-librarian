import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Copy,
  LayoutDashboard,
  Library,
  Menu,
  Settings,
  Users,
  X,
} from "lucide-react";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { UserMenu } from "./UserMenu";

const navGroups = [
  {
    label: "Overview",
    items: [
      { label: "Home", to: "/dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "Insights",
    items: [
      { label: "Duplicates", to: "/duplicates", icon: Copy, search: { type: "all" } },
      { label: "Users", to: "/users", icon: Users, search: { filter: "all" } },
      { label: "Activity", to: "/activity", icon: Activity },
    ],
  },
  {
    label: "Manage",
    items: [
      { label: "Settings", to: "/settings", icon: Settings },
    ],
  },
] as const;

export function AppSidebar() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => setMobileOpen(false), [pathname]);

  return (
    <>
      <header className="app-mobile-bar">
        <Brand />
        <button
          type="button"
          className="btn btn-ghost btn-circle btn-sm"
          aria-label="Open navigation"
          onClick={() => setMobileOpen(true)}
        >
          <Menu className="size-5" />
        </button>
      </header>

      <aside
        className={`app-sidebar ${collapsed ? "is-collapsed" : ""}`}
        aria-label="Application sidebar"
      >
        <button
          type="button"
          className="sidebar-collapse"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          aria-controls="desktop-sidebar-content"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
        </button>
        <SidebarContent collapsed={collapsed} id="desktop-sidebar-content" />
      </aside>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.button
              type="button"
              className="sidebar-backdrop"
              aria-label="Close navigation"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              className="app-sidebar app-sidebar-mobile"
              aria-label="Mobile navigation"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 360, damping: 34 }}
            >
              <button
                type="button"
                className="btn btn-ghost btn-circle btn-sm sidebar-mobile-close"
                aria-label="Close navigation"
                onClick={() => setMobileOpen(false)}
              >
                <X className="size-5" />
              </button>
              <SidebarContent collapsed={false} id="mobile-sidebar-content" />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function Brand() {
  return (
    <Link to="/dashboard" className="sidebar-brand" aria-label="Plex Librarian dashboard">
      <span className="sidebar-brand-mark"><Library className="size-5" /></span>
      <span className="sidebar-brand-copy">
        <strong>Plex Librarian</strong>
        <small>Library health</small>
      </span>
    </Link>
  );
}

function SidebarContent({ collapsed, id }: { collapsed: boolean; id: string }) {
  return (
    <div className="sidebar-content" id={id}>
      <Brand />
      <nav className="sidebar-nav" aria-label="Primary navigation">
        {navGroups.map((group) => (
          <div className="sidebar-group" key={group.label}>
            <div className="sidebar-group-label">{group.label}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  search={"search" in item ? item.search : undefined}
                  className="sidebar-link"
                  activeProps={{
                    className: "sidebar-link is-active",
                    "aria-current": "page",
                  }}
                  title={collapsed ? item.label : undefined}
                >
                  <span className="sidebar-link-icon"><Icon className="size-[18px]" /></span>
                  <span className="sidebar-link-label">{item.label}</span>
                  <span className="sidebar-active-dot" />
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-footer-label">Appearance & account</div>
        <div className="sidebar-footer-actions">
          <ThemeSwitcher sidebar />
          <UserMenu sidebar />
        </div>
      </div>
    </div>
  );
}
