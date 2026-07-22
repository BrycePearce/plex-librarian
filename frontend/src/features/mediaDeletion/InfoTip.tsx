import { Info } from "lucide-react";
import { HoverPopover } from "../../components/HoverPopover.tsx";

export function InfoTip({ text }: { text: string }) {
  return (
    <HoverPopover content={text}>
      <button
        type="button"
        className="inline-flex cursor-help text-base-content/45 transition-colors hover:text-base-content/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        aria-label={text}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <Info className="size-3.5" />
      </button>
    </HoverPopover>
  );
}
