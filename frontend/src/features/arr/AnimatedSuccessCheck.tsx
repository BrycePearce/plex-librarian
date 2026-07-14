export function AnimatedSuccessCheck() {
  return (
    <svg
      className="arr-test-success size-5"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        className="arr-test-success-check"
        d="m7.5 12 3 3 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        className="arr-test-success-ring"
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
