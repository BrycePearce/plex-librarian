import { useEffect, useRef, useState } from "react";

export function CustomDaysInput({
  initialDays,
  maxDays,
  label,
  onChange,
}: {
  initialDays: number;
  maxDays: number;
  label: string;
  onChange: (days: number) => void;
}) {
  const [value, setValue] = useState(String(initialDays));
  const lastApplied = useRef(initialDays);
  const onChangeRef = useRef(onChange);
  const parsed = Number(value);
  const valid = value !== "" &&
    Number.isInteger(parsed) &&
    parsed >= 0 &&
    parsed <= maxDays;

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    setValue(String(initialDays));
    lastApplied.current = initialDays;
  }, [initialDays]);

  useEffect(() => {
    if (!valid || parsed === lastApplied.current) return;
    const timer = setTimeout(() => {
      lastApplied.current = parsed;
      onChangeRef.current(parsed);
    }, 400);
    return () => clearTimeout(timer);
  }, [parsed, valid]);

  return (
    <div className="join">
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={String(maxDays).length}
        className={`input input-bordered input-sm join-item w-24 ${!valid ? "input-error" : ""}`}
        value={value}
        onChange={(event) =>
          setValue(
            event.target.value.replace(/\D/g, "").slice(0, String(maxDays).length),
          )}
        aria-label={label}
        title={`Enter 0–${maxDays.toLocaleString()} whole days`}
      />
      <span className="btn btn-sm join-item pointer-events-none font-normal">
        days
      </span>
    </div>
  );
}
