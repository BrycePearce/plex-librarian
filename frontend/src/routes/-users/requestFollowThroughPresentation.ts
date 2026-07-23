import type { PlexUser } from "../../lib/api.ts";

type Assessment = PlexUser["requestFollowThrough"];

export function getRequestFollowThroughPresentation(assessment: Assessment) {
  if (assessment.status === "healthy") {
    return {
      label: "Healthy",
      detail: `${assessment.nonWatchPercent}% not watched`,
      badgeClass: "badge-success",
    };
  }

  if (assessment.status === "watch") {
    return {
      label: "Watch",
      detail: `${assessment.nonWatchPercent}% not watched`,
      badgeClass: "badge-warning",
    };
  }

  if (assessment.status === "review") {
    return {
      label: "Review",
      detail: `${assessment.nonWatchPercent}% not watched`,
      badgeClass: "badge-error",
    };
  }

  const hasEligibleRequests = assessment.eligibleRequestCount > 0;
  return {
    label: hasEligibleRequests ? "Limited data" : "Not enough data",
    detail: hasEligibleRequests
      ? `${assessment.eligibleRequestCount} eligible ${
        assessment.eligibleRequestCount === 1 ? "request" : "requests"
      }`
      : "No eligible requests yet",
    badgeClass: "badge-ghost",
  };
}
