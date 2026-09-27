import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import {
  ArrowRight,
  ChevronDown,
  Copy,
  Film,
  Library as LibraryGlyph,
  Music,
  Tv,
  Users,
} from "lucide-react";
import type { Library } from "../../lib/api.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { SectionHeading } from "../../components/Workspace.tsx";
import { cardVariants, containerVariants, pageSectionVariants } from "./animation.ts";

export function HomeDirectory({ libraries }: { libraries: Library[] }) {
  const [showAllLibraries, setShowAllLibraries] = useState(false);
  const visibleLibraries = showAllLibraries ? libraries : libraries.slice(0, 6);
  const sections = [
    {
      index: "02",
      to: "/duplicates" as const,
      icon: Copy,
      tone: "accent",
      label: "Versions",
      title: "Duplicates",
      detail: "Compare multiple synced versions of movies and episodes.",
      cta: "Open duplicates",
      search: { type: "all" as const },
    },
    {
      index: "03",
      to: "/users" as const,
      icon: Users,
      tone: "primary",
      label: "Viewing",
      title: "Users",
      detail: "Explore viewing history and activity across Plex users.",
      cta: "Open users",
      search: { filter: "all" as const },
    },
  ];

  return (
    <motion.section
      className="home-directory"
      variants={pageSectionVariants}
    >
      <SectionHeading eyebrow="Workspace" title="Explore Plex Librarian" />
      <motion.div
        className="home-directory-list"
        variants={containerVariants}
      >
        <motion.div
          variants={cardVariants}
          className="home-stale-section home-collection-section"
        >
          <div className="home-stale-heading">
            <span className="home-directory-index">01</span>
            <span className="home-directory-icon">
              <LibraryGlyph className="size-5" />
            </span>
            <span className="home-directory-copy">
              <small>Collection</small>
              <strong>Libraries</strong>
              <span>
                Select a library to review stale and unwatched content.
              </span>
            </span>
            <span className="home-collection-count">
              {libraries.length} active
            </span>
          </div>
          <div className="home-stale-libraries">
            {visibleLibraries.map((library) => (
              <Link
                key={library.key}
                to="/libraries/$key/stale"
                params={{ key: library.key }}
                className={`home-stale-library home-library-${library.type}`}
              >
                <LibraryIcon type={library.type} />
                <span className="home-library-name">
                  <strong>{library.title}</strong>
                  <small>
                    {library.itemCount.toLocaleString()} items ·{" "}
                    {formatKilobytes(library.totalFileSize)}
                  </small>
                </span>
                {library.historySyncedAt === null && <i title="Watch history is still syncing" />}
                <ArrowRight className="size-3.5" />
              </Link>
            ))}
            {libraries.length > 6 && (
              <button
                type="button"
                className="home-library-more"
                onClick={() => setShowAllLibraries((value) => !value)}
              >
                <ChevronDown
                  className={`size-4 ${showAllLibraries ? "rotate-180" : ""}`}
                />
                {showAllLibraries ? "Show fewer" : `Show ${libraries.length - 6} more`}
              </button>
            )}
          </div>
        </motion.div>
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <motion.div key={section.to} variants={cardVariants}>
              <Link
                to={section.to}
                search={"search" in section ? section.search : undefined}
                className={`home-directory-section home-directory-${section.tone}`}
              >
                <span className="home-directory-index">{section.index}</span>
                <span className="home-directory-icon">
                  <Icon className="size-5" />
                </span>
                <span className="home-directory-copy">
                  <small>{section.label}</small>
                  <strong>{section.title}</strong>
                  <span>{section.detail}</span>
                </span>
                <span className="home-directory-cta">
                  {section.cta} <ArrowRight className="size-4" />
                </span>
              </Link>
            </motion.div>
          );
        })}
      </motion.div>
    </motion.section>
  );
}

function LibraryIcon({ type }: { type: string }) {
  const cls = "w-8 h-8 p-1.5 rounded-lg shrink-0";
  if (type === "movie") {
    return <Film className={`${cls} bg-primary/20 text-primary`} />;
  }
  if (type === "show") {
    return <Tv className={`${cls} bg-secondary/20 text-secondary`} />;
  }
  if (type === "artist") {
    return <Music className={`${cls} bg-accent/20 text-accent`} />;
  }
  return <Film className={`${cls} bg-base-300 text-base-content/40`} />;
}
