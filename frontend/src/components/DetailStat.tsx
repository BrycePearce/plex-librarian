export function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-base-content/40">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
