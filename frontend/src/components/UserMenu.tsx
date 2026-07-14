import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  ExternalLink,
  ChevronUp,
  LogOut,
  User,
} from "lucide-react";
import { api, invalidateServerScopedQueries } from "../lib/api";
import type { AuthStatus } from "../lib/api";
import { avatarUrl } from "../lib/avatar";
import { useClickOutside } from "../lib/useClickOutside";

export function UserMenu({ sidebar = false }: { sidebar?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useClickOutside(rootRef, () => setOpen(false), open);

  const { data: authStatus, isPending } = useQuery<AuthStatus>({
    queryKey: ["auth", "status"],
    queryFn: api.auth.status,
    staleTime: 60_000,
  });

  const disconnect = useMutation({
    mutationFn: api.auth.disconnect,
    onSuccess: async () => {
      setOpen(false);
      await qc.invalidateQueries({ queryKey: ["auth", "status"] });
      await invalidateServerScopedQueries(qc);
      void navigate({ to: "/setup" });
    },
  });

  // Same footprint as the real button below — this query resolves after first paint (it
  // races the same queryKey the route's beforeLoad already kicked off), so without a
  // same-size placeholder here the avatar pops in and shifts ThemeSwitcher beside it.
  if (isPending) {
    return <div className={`skeleton shrink-0 ${sidebar ? "h-12 w-full rounded-xl" : "w-8 h-8 rounded-full"}`} />;
  }

  if (!authStatus?.configured) return null;

  const { user } = authStatus;

  return (
    <div className={`relative ${sidebar ? "sidebar-control" : ""}`} ref={rootRef}>
      <button
        type="button"
        className={sidebar ? "sidebar-control-button" : "btn btn-ghost btn-circle btn-sm"}
        onClick={() => setOpen((o) => !o)}
        title={user?.username ?? "Account"}
        aria-label={user?.username ? `Account menu for ${user.username}` : "Account menu"}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {user?.thumb
          ? (
            <img
              src={avatarUrl(user.thumb)}
              alt={user.username}
              className="w-6 h-6 rounded-full object-cover"
            />
          )
          : <User className="w-4 h-4" />}
        {sidebar && (
          <>
            <span className="sidebar-control-copy">
              <strong>Account</strong>
              <small>{user?.username ?? "Plex account"}</small>
            </span>
            <ChevronUp className={`size-4 sidebar-control-chevron ${open ? "is-open" : ""}`} />
          </>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            role="menu"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ type: "spring", stiffness: 400, damping: 28 }}
            className={`menu absolute z-50 w-52 rounded-box bg-base-200 shadow-xl p-2 ${sidebar ? "bottom-full left-0 mb-2 origin-bottom-left" : "right-0 mt-2 origin-top-right"}`}
          >
            {user?.username && (
              <li className="menu-title truncate">
                <span>{user.username}</span>
              </li>
            )}
            <li>
              <a
                href="https://app.plex.tv/desktop/#!/"
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                className="flex items-center gap-2 leading-none"
                onClick={() => setOpen(false)}
              >
                <ExternalLink className="w-4 h-4" />
                Open Plex
              </a>
            </li>
            {authStatus.source !== "env" && (
              <li>
                <button
                  type="button"
                  role="menuitem"
                  className="flex items-center gap-2 leading-none"
                  onClick={() => disconnect.mutate()}
                  disabled={disconnect.isPending}
                >
                  <LogOut className="w-4 h-4" />
                  Disconnect
                </button>
              </li>
            )}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
