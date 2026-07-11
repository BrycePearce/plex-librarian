export function Pagination(
  { page, totalPages, onPageChange }: {
    page: number;
    totalPages: number;
    onPageChange: (page: number) => void;
  },
) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex justify-center gap-2">
      <button
        type="button"
        className="btn btn-sm"
        disabled={page === 0}
        onClick={() => onPageChange(page - 1)}
      >
        Previous
      </button>
      <span className="btn btn-sm btn-ghost no-animation pointer-events-none">
        {page + 1} / {totalPages}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={page >= totalPages - 1}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </button>
    </div>
  );
}
