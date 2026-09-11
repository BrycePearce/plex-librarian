import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceDeletionOutcomes } from "./ServiceDeletionOutcomes.tsx";
import type { DeletionOperationTarget } from "@shared/types";

Deno.test("repeated season outcomes have a compact summary and preserve every request in Advanced", () => {
  const outcomes: NonNullable<DeletionOperationTarget["serviceOutcomes"]> = [
    ...Array.from({ length: 25 }, (_, index) => ({
      service: "Sonarr",
      action: "Unmonitor selected episode",
      startedAt: index,
      status: "succeeded" as const,
      httpStatus: 200,
    })),
    ...Array.from({ length: 2 }, () => ({
      service: "Sonarr",
      action: "Delete selected file",
      startedAt: 26,
      status: "succeeded" as const,
      httpStatus: 204,
    })),
    { service: "Plex", action: "Delete selected season", startedAt: 27, status: "succeeded" },
  ];
  const markup = renderToStaticMarkup(createElement(ServiceDeletionOutcomes, { outcomes }));
  const [summary, evidence] = markup.split("<details");
  assertEquals((summary.match(/<p /g) ?? []).length, 3);
  assertStringIncludes(summary, "Unmonitor selected episode (25 outcomes)");
  assertStringIncludes(summary, "Delete selected file (2 outcomes)");
  assertEquals((evidence.match(/<p /g) ?? []).length, 28);
  assertEquals((evidence.match(/HTTP 200/g) ?? []).length, 25);
  assertEquals((evidence.match(/HTTP 204/g) ?? []).length, 2);
});

Deno.test("grouping keeps mixed statuses, different services and actions distinct", () => {
  const statuses = ["succeeded", "accepted", "reconciled", "failed", "uncertain"] as const;
  const outcomes: NonNullable<DeletionOperationTarget["serviceOutcomes"]> = statuses.flatMap(
    (status) =>
      [1, 2].map((index) => ({
        service: "Sonarr",
        action: "Delete selected file",
        startedAt: index,
        status,
        httpStatus: status === "failed" ? 400 + index : undefined,
        error: status === "failed" || status === "uncertain"
          ? `${status} detail ${index}`
          : undefined,
      })),
  );
  outcomes.push(
    { service: "Radarr", action: "Delete selected file", startedAt: 3, status: "succeeded" },
    { service: "Sonarr", action: "Unmonitor selected episode", startedAt: 4, status: "succeeded" },
  );
  const markup = renderToStaticMarkup(createElement(ServiceDeletionOutcomes, { outcomes }));
  const [summary, evidence] = markup.split("<details");
  assertEquals((summary.match(/<p /g) ?? []).length, 7);
  assertEquals((summary.match(/\(2 outcomes\)/g) ?? []).length, 5);
  for (
    const message of [
      "service reported success",
      "request accepted",
      "no additional file deletion sent",
      "request failed; automatic replay is held",
      "outcome uncertain; automatic replay is held",
    ]
  ) assertStringIncludes(summary, message);
  assertEquals((evidence.match(/<p /g) ?? []).length, 12);
  for (
    const detail of [
      "failed detail 1",
      "failed detail 2",
      "uncertain detail 1",
      "uncertain detail 2",
      "HTTP 401",
      "HTTP 402",
    ]
  ) {
    assertStringIncludes(evidence, detail);
  }
});

Deno.test("ordinary service results distinguish success, acceptance, reconciliation, failure and uncertainty", () => {
  const markup = renderToStaticMarkup(createElement(ServiceDeletionOutcomes, {
    outcomes: ["succeeded", "accepted", "reconciled", "failed", "uncertain"].map((status) => ({
      service: "Fixture",
      action: "Delete selected file",
      startedAt: 1,
      status: status as "succeeded" | "accepted" | "reconciled" | "failed" | "uncertain",
      httpStatus: status === "failed" ? 403 : undefined,
    })),
  }));
  for (
    const text of [
      "service reported success",
      "request accepted",
      "no additional file deletion sent",
      "request failed",
      "outcome uncertain",
      "Advanced service evidence",
      "HTTP 403",
    ]
  ) assertStringIncludes(markup, text);
  assertEquals(markup.includes("hardlink"), false);
  assertEquals(markup.includes("physical completion"), false);
  assertEquals(markup.includes("<details open"), false);
  assertEquals(renderToStaticMarkup(createElement(ServiceDeletionOutcomes, { outcomes: [] })), "");
});
