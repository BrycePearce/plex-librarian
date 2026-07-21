// `hoverScope` selects which ancestor's `:hover` state drives the shadow/ring transition:
// "poster" for a wrapper that itself declares `group/poster` (the containing link), "row"
// for one that relies on an ancestor's plain `group` (e.g. the table row). Omitting it
// renders a plain, non-interactive image/placeholder with no wrapper div at all — the
// shape the show-detail header thumbnail needs.
export function PosterThumb({
  thumb,
  width,
  height,
  className,
  hoverScope,
}: {
  thumb: string | null;
  width: number;
  height: number;
  className: string;
  hoverScope?: "poster" | "row";
}) {
  const url = thumb
    ? `/api/proxy/thumb?path=${encodeURIComponent(thumb)}&width=${width}&height=${height}`
    : null;

  if (!hoverScope) {
    return url
      ? (
        <img
          src={url}
          alt=""
          className={`${className} object-cover rounded bg-base-300 shrink-0`}
        />
      )
      : <div className={`${className} rounded bg-base-300 shrink-0`} />;
  }

  const ringPrefix = hoverScope === "poster" ? "group-hover/poster" : "group-hover";
  return (
    <div
      className={`${className} rounded overflow-hidden shrink-0 bg-base-300 transition-shadow duration-200 ${ringPrefix}:shadow-lg ${ringPrefix}:ring-2 ${ringPrefix}:ring-primary/40`}
    >
      {url && (
        <img
          src={url}
          alt=""
          className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-110"
          loading="lazy"
        />
      )}
    </div>
  );
}
