import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ChevronUp, ExternalLink, LogOut, User } from "lucide-react";
import { api } from "../lib/api";
import { clearServerScopedQueries } from "../lib/queryCache";
import { queryKeys } from "../lib/queryKeys";
import type { AuthStatus } from "../lib/api";
import { avatarUrl } from "../lib/avatar";
import { useClickOutside } from "../lib/useClickOutside";
import { useDisconnectTransition } from "../features/auth/DisconnectTransition";

const DISCONNECT_LOADER_MIN_MS = 350;

export function UserMenu({ sidebar = false }: { sidebar?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const disconnectStartedAt = useRef(0);
  const { beginDisconnect, endDisconnect } = useDisconnectTransition();

  useClickOutside(rootRef, () => setOpen(false), open);

  const { data: authStatus, isPending } = useQuery<AuthStatus>({
    queryKey: queryKeys.auth.status,
    queryFn: api.auth.status,
    staleTime: 60_000,
  });

  const disconnect = useMutation({
    mutationFn: api.auth.disconnect,
    onMutate: () => {
      disconnectStartedAt.current = Date.now();
      beginDisconnect();
    },
    onSuccess: async () => {
      setOpen(false);
      const remainingLoaderTime = DISCONNECT_LOADER_MIN_MS -
        (Date.now() - disconnectStartedAt.current);
      if (remainingLoaderTime > 0) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, remainingLoaderTime));
      }
      qc.setQueryData<AuthStatus>(queryKeys.auth.status, {
        configured: false,
        source: null,
      });
      try {
        await navigate({ to: "/setup", replace: true });
        await clearServerScopedQueries(qc);
      } finally {
        endDisconnect();
      }
    },
    onError: () => endDisconnect(),
  });

  const requestDisconnect = () => {
    disconnect.reset();
    disconnect.mutate();
  };

  // Same footprint as the real button below — this query resolves after first paint (it
  // races the same queryKey the route's beforeLoad already kicked off), so without a
  // same-size placeholder here the avatar pops in and shifts ThemeSwitcher beside it.
  if (isPending) {
    return (
      <div
        className={`skeleton shrink-0 ${
          sidebar ? "h-12 w-full rounded-xl" : "w-8 h-8 rounded-full"
        }`}
      />
    );
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
            className={`menu absolute z-50 w-52 rounded-box bg-base-200 shadow-xl p-2 ${
              sidebar
                ? "bottom-full left-0 mb-2 origin-bottom-left"
                : "right-0 mt-2 origin-top-right"
            }`}
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
              <>
                <li>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex items-center gap-2 leading-none"
                    onClick={requestDisconnect}
                    disabled={disconnect.isPending}
                  >
                    <LogOut className="w-4 h-4" />
                    Disconnect
                  </button>
                </li>
                {disconnect.isError && (
                  <li
                    role="alert"
                    className="px-3 py-2 text-xs leading-relaxed text-error"
                  >
                    {disconnect.error instanceof Error
                      ? disconnect.error.message
                      : "Unable to disconnect from Plex"}
                  </li>
                )}
              </>
            )}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
