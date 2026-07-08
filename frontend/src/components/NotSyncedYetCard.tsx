export function NotSyncedYetCard({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <div className="card bg-base-200 shadow-xl">
      <div className="card-body items-center text-center gap-4 py-14">
        <span className="loading loading-ring w-12 text-primary" />
        <div>
          <h2 className="card-title text-xl justify-center">{title}</h2>
          <p className="text-base-content/60 max-w-md">{message}</p>
        </div>
      </div>
    </div>
  );
}
