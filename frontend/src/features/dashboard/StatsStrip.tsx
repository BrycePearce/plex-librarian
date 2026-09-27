import type { ReactNode } from "react";
import { motion } from "motion/react";
import { Clock, Database, HardDrive, Trash2 } from "lucide-react";
import type { Library } from "../../lib/api.ts";
import { formatKilobytes, formatRelativeTime } from "../../lib/format.ts";
import { cardVariants, containerVariants } from "./animation.ts";
import { useCountUp } from "./useCountUp.ts";

export function StatsStrip({
  libraries,
  mediaSizeRemoved,
}: {
  libraries: Library[];
  mediaSizeRemoved: number;
}) {
  const totals = libraries.reduce(
    (acc, lib) => {
      acc.items += lib.itemCount;
      acc.size += lib.totalFileSize;
      acc.lastSync = Math.max(acc.lastSync, lib.syncedAt);
      return acc;
    },
    { items: 0, size: 0, lastSync: 0 },
  );

  const animatedItems = useCountUp(totals.items, 900);
  const animatedSize = useCountUp(totals.size, 900);
  const animatedRemovedSize = useCountUp(mediaSizeRemoved, 900);

  return (
    <motion.div
      variants={containerVariants}
      className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4"
    >
      <StatTile
        icon={<Database className="w-5 h-5" />}
        iconClass="bg-primary/20 text-primary"
        tone="primary"
        label="Total items"
        value={animatedItems.toLocaleString()}
      />
      <StatTile
        icon={<HardDrive className="w-5 h-5" />}
        iconClass="bg-secondary/20 text-secondary"
        tone="secondary"
        label="Library size"
        value={formatKilobytes(animatedSize)}
      />
      <StatTile
        icon={<Trash2 className="w-5 h-5" />}
        iconClass="bg-primary/20 text-primary"
        tone="primary"
        label="Media removed"
        value={formatKilobytes(animatedRemovedSize)}
        title="Logical media size from completed deletion workflows. Ordinary deletions use service-reported success or acceptance; disk space recovered is not measured."
      />
      <StatTile
        icon={<Clock className="w-5 h-5" />}
        iconClass="bg-accent/20 text-accent"
        tone="accent"
        label="Last synced"
        value={totals.lastSync ? formatRelativeTime(totals.lastSync) : "—"}
      />
    </motion.div>
  );
}

function StatTile({
  icon,
  iconClass,
  tone,
  label,
  value,
  title,
}: {
  icon: ReactNode;
  iconClass: string;
  tone: "primary" | "secondary" | "accent";
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <motion.div
      variants={cardVariants}
      className={`dashboard-stat-card dashboard-stat-${tone}`}
      title={title}
    >
      <div className="dashboard-stat-content">
        <div
          className={`dashboard-stat-icon ${iconClass}`}
        >
          {icon}
        </div>
        <div className="dashboard-stat-copy">
          <p>{label}</p>
          <strong>{value}</strong>
        </div>
      </div>
    </motion.div>
  );
}
