import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";

export function ArrUrlHelp({ type }: { type: "radarr" | "sonarr" }) {
  const [open, setOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  const appName = type === "radarr" ? "Radarr" : "Sonarr";
  const port = type === "radarr" ? "7878" : "8989";
  const docsUrl = type === "radarr"
    ? "https://wiki.servarr.com/radarr/settings#host"
    : "https://wiki.servarr.com/sonarr/settings#host";

  useEffect(() => {
    if (!open) return;

    function closeOnOutsideClick(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !helpRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={helpRef} className="relative">
      <button
        type="button"
        className="grid size-5 place-items-center rounded-full text-base-content/45 transition hover:bg-base-200 hover:text-base-content focus-visible:outline-2 focus-visible:outline-primary"
        aria-label="How to find the connection URL"
        aria-expanded={open}
        aria-controls="arr-url-help"
        onClick={() => setOpen((value) => !value)}
      >
        <Info className="size-3.5" />
      </button>

      {open && (
        <div
          id="arr-url-help"
          role="note"
          aria-label={`${appName} URL help`}
          className="absolute left-0 top-7 z-30 block w-[min(24rem,calc(100vw-3rem))] rounded-xl border border-base-300 bg-base-100 p-4 text-left text-xs font-normal leading-relaxed text-base-content/70 shadow-xl"
        >
          <strong className="block text-sm text-base-content">
            Which URL should I use?
          </strong>
          <span className="mt-1 block">
            Use an address Plex Librarian can reach from inside its container. This may differ from
            the address in your browser.
          </span>
          <ul className="mt-3 list-disc space-y-1.5 pl-4">
            <li>
              <strong>Unraid:</strong> find {appName} on the Docker tab and use its{" "}
              <strong>LAN IP:PORT</strong> value, prefixed with{" "}
              <code>http://</code>. Do not use the value in the <strong>Container IP / MAC</strong>
              {" "}
              column.
            </li>
            <li>
              <strong>Docker Compose or a shared Docker network:</strong>{" "}
              use the service or container name, such as{" "}
              <code>
                http://{type}:{port}
              </code>
              .
            </li>
            <li>
              <strong>Another computer:</strong> use that computer's LAN hostname or IP and the{" "}
              {appName} port.
            </li>
          </ul>
          <span className="mt-3 block">
            Avoid <code>localhost</code> and{" "}
            <code>127.0.0.1</code>; they point back to the Plex Librarian container itself.
          </span>
          <a
            className="link link-primary mt-3 inline-block"
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open the {appName} host settings guide
          </a>
        </div>
      )}
    </div>
  );
}
