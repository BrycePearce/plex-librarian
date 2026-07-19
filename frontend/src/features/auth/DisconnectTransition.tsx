import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

interface DisconnectTransitionContextValue {
  beginDisconnect: () => void;
  endDisconnect: () => void;
}

const DisconnectTransitionContext = createContext<
  DisconnectTransitionContextValue | null
>(null);

export function useDisconnectTransition(): DisconnectTransitionContextValue {
  const context = useContext(DisconnectTransitionContext);
  if (!context) {
    throw new Error(
      "useDisconnectTransition must be used within DisconnectTransitionProvider",
    );
  }
  return context;
}

export function DisconnectTransitionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [disconnecting, setDisconnecting] = useState(false);
  const beginDisconnect = useCallback(() => setDisconnecting(true), []);
  const endDisconnect = useCallback(() => setDisconnecting(false), []);
  const value = useMemo(
    () => ({ beginDisconnect, endDisconnect }),
    [beginDisconnect, endDisconnect],
  );

  return (
    <DisconnectTransitionContext.Provider value={value}>
      {children}
      <AnimatePresence>
        {disconnecting && <DisconnectLoader />}
      </AnimatePresence>
    </DisconnectTransitionContext.Provider>
  );
}

function DisconnectLoader() {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className="fixed inset-0 z-[100] grid place-items-center bg-base-100/95 backdrop-blur-sm"
      role="status"
      aria-live="assertive"
      aria-label="Disconnecting from Plex"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.14 }}
    >
      <span className="loading loading-ring loading-lg text-primary" />
    </motion.div>
  );
}
