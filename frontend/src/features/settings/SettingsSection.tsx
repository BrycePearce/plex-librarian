import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function SettingsSection({
  icon: Icon,
  tone,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  tone: "primary" | "secondary" | "accent";
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`workspace-surface settings-section settings-section-${tone}`}
    >
      <header className="settings-section-header">
        <span className="settings-section-icon">
          <Icon className="size-5" />
        </span>
        <span>
          <small>Preferences</small>
          <h2>{title}</h2>
          <p>{description}</p>
        </span>
      </header>
      <div className="settings-section-fields">{children}</div>
    </section>
  );
}

export function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-field-row">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  );
}

export function LoadingDaysInput({ label }: { label: string }) {
  return (
    <input
      type="number"
      className="input input-bordered input-sm w-24"
      disabled
      aria-label={label}
    />
  );
}
