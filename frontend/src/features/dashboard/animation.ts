import type { Variants } from "motion/react";

// Shared orchestration for the stats strip and library grid: the container just declares
// the stagger timing, each child only needs `variants={cardVariants}` to inherit the
// hidden → show transition from whichever container it's mounted under.
export const containerVariants: Variants = {
  hidden: { opacity: 1 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.025 },
  },
};

export const pageVariants: Variants = {
  hidden: { opacity: 0, y: 7 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.26, ease: "easeOut" },
  },
};

export const pageSectionVariants: Variants = {
  hidden: { opacity: 1, y: 0 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.2, ease: "easeOut" },
  },
};

export const cardVariants: Variants = {
  hidden: { opacity: 0.72, y: 4 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.2, ease: "easeOut" },
  },
};
