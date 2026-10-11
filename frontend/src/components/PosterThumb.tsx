import { useState } from "react";
import { Film, Images, Music2, Tv } from "lucide-react";

export function MediaArtworkFallback({
  mediaType,
  className = "",
}: { mediaType?: string | null; className?: string }) {
  const Icon = mediaType === "movie"
    ? Film
    : ["tv", "show", "season", "episode"].includes(mediaType ?? "")
    ? Tv
    : ["music", "artist", "album", "track"].includes(mediaType ?? "")
    ? Music2
    : Images;
  return (
    <span
      aria-hidden="true"
      className={`${className} grid place-items-center shrink-0 overflow-hidden rounded-lg border border-base-content/10 bg-linear-to-br from-base-content/5 to-base-200 text-base-content/50`}
    >
      <Icon className="w-2/5 h-auto max-w-6" strokeWidth={1.5} />
    </span>
  );
}

// A new source remounts this component so a failed image never poisons another poster.
function PosterImage({ url, mediaType, className, loading }: {
  url: string | null;
  mediaType?: string | null;
  className: string;
  loading?: "eager" | "lazy";
}) {
  const [failed, setFailed] = useState(false);
  return url && !failed
    ? (
      <img
        src={url}
        alt=""
        loading={loading}
        decoding="async"
        className={className}
        onError={() => setFailed(true)}
      />
    )
    : <MediaArtworkFallback mediaType={mediaType} className={className} />;
}

// hoverScope matches the containing link's group/poster or the table row's group.
export function PosterThumb({
  thumb,
  mediaType,
  width,
  height,
  className,
  hoverScope,
  loading,
}: {
  thumb: string | null;
  mediaType?: string | null;
  width: number;
  height: number;
  className: string;
  hoverScope?: "poster" | "row";
  loading?: "eager" | "lazy";
}) {
  const url = thumb
    ? `/api/proxy/thumb?path=${encodeURIComponent(thumb)}&width=${width}&height=${height}`
    : null;
  if (!hoverScope) {
    return (
      <PosterImage
        key={url}
        url={url}
        mediaType={mediaType}
        loading={loading}
        className={`${className} object-cover rounded bg-base-300 shrink-0`}
      />
    );
  }
  const ringPrefix = hoverScope === "poster" ? "group-hover/poster" : "group-hover";
  return (
    <div
      className={`${className} rounded overflow-hidden shrink-0 bg-base-300 transition-shadow duration-200 ${ringPrefix}:shadow-lg ${ringPrefix}:ring-2 ${ringPrefix}:ring-primary/40`}
    >
      <PosterImage
        key={url}
        url={url}
        mediaType={mediaType}
        loading={loading ?? "lazy"}
        className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-110"
      />
    </div>
  );
}
