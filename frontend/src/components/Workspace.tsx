import type { LucideIcon } from "lucide-react";
import { ArrowLeft } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import "./workspace.css";

export function PageHeader({
  eyebrow,
  title,
  description,
  icon: Icon,
  tone = "primary",
  backTo = "/dashboard",
  actions,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  tone?: "primary" | "secondary" | "accent";
  backTo?: "/dashboard";
  actions?: ReactNode;
}) {
  return (
    <header className={`workspace-page-header workspace-tone-${tone}`}>
      <div className="workspace-page-heading">
        <Link
          to={backTo}
          className="workspace-back-button"
          aria-label="Back to dashboard"
          title="Back to dashboard"
        >
          <ArrowLeft className="size-4" />
        </Link>
        {Icon && (
          <span className="workspace-page-icon">
            <Icon className="size-5" />
          </span>
        )}
        <div className="workspace-page-copy">
          <span className="workspace-eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
      </div>
      {actions && <div className="workspace-page-actions">{actions}</div>}
    </header>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  meta,
}: {
  eyebrow: string;
  title: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="workspace-section-heading">
      <div>
        <span className="workspace-eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {meta && <div className="workspace-section-meta">{meta}</div>}
    </div>
  );
}

export function CollectionToolbar({
  eyebrow,
  title,
  actions,
  meta,
}: {
  eyebrow: string;
  title: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="workspace-collection-toolbar">
      <div className="workspace-collection-title">
        <span className="workspace-eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      <div className="workspace-collection-actions">
        {actions}
        {meta && <div className="workspace-collection-meta">{meta}</div>}
      </div>
    </div>
  );
}

export function DataSurface({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`workspace-surface ${className}`}>{children}</section>;
}

export function FilterSurface({ children }: { children: ReactNode }) {
  return <div className="workspace-filter-surface">{children}</div>;
}
