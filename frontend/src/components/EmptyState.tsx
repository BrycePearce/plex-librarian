import type { LucideIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, scale: 0.99 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="card bg-base-200 relative overflow-hidden border border-base-300/60"
    >
      <div className="absolute left-1/2 top-0 h-36 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
      <div className="card-body relative items-center text-center py-14 gap-4">
        <div className="w-12 h-12 rounded-2xl bg-primary/12 text-primary ring-1 ring-primary/20 flex items-center justify-center shadow-sm">
          <Icon className="w-6 h-6" strokeWidth={1.75} />
        </div>
        <div className="space-y-1 max-w-md">
          <h2 className="font-semibold text-lg">{title}</h2>
          <p className="text-sm text-base-content/50">{description}</p>
        </div>
        {action}
      </div>
    </motion.div>
  );
}
