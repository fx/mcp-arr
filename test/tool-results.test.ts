import { describe, expect, it } from "vitest";
import { createToolError } from "../src/tools/errors.js";
import {
  applicationOutcome,
  buildToolResult,
  type ItemOutcome,
  summarizeToolResult,
  toolResultSchema,
} from "../src/tools/results.js";
import { capabilitiesOutputSchema } from "../src/tools/schemas/capabilities.js";

const baseSchema = toolResultSchema();
const mutationSchema = toolResultSchema({ mutation: true });

function okOutcome(application: "sonarr" | "radarr" | "prowlarr") {
  return applicationOutcome({ application, status: "ok" });
}

function failedOutcome(application: "sonarr" | "radarr" | "prowlarr") {
  return applicationOutcome({
    application,
    status: "unavailable",
    error: createToolError({
      code: "unavailable_application",
      message: `${application}: the request could not reach the instance`,
      application,
    }),
  });
}

describe("tool result envelope", () => {
  it("reports ok only when every outcome is clean", () => {
    const result = buildToolResult({ applications: [okOutcome("sonarr"), okOutcome("radarr")] });

    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
    expect(baseSchema.safeParse(result).success).toBe(true);
  });

  it("reports a cross-application partial failure without concealing either half", () => {
    const result = buildToolResult({
      applications: [okOutcome("sonarr"), failedOutcome("radarr")],
    });

    expect(result.status).toBe("partial");
    expect(result.applications.map((outcome) => [outcome.application, outcome.status])).toEqual([
      ["sonarr", "ok"],
      ["radarr", "unavailable"],
    ]);
    expect(result.applications[1]?.error?.code).toBe("unavailable_application");
    expect(result.errors.map((error) => error.code)).toEqual(["partial_failure"]);
    expect(baseSchema.safeParse(result).success).toBe(true);
  });

  it("reports error when nothing succeeded", () => {
    const result = buildToolResult({
      applications: [failedOutcome("sonarr"), failedOutcome("radarr")],
    });

    expect(result.status).toBe("error");
    expect(result.errors).toEqual([]);
  });

  it("treats a failed item inside a successful application as partial", () => {
    const items: readonly ItemOutcome[] = [
      { reference: "que_00000001", status: "ok", warnings: [] },
      {
        reference: "que_00000002",
        status: "error",
        warnings: [],
        error: createToolError({
          code: "stale_reference",
          message: "the queue reference expired",
          application: "sonarr",
        }),
      },
    ];
    const result = buildToolResult({
      applications: [applicationOutcome({ application: "sonarr", status: "ok", items })],
    });

    expect(result.status).toBe("partial");
    expect(result.errors.map((error) => error.code)).toEqual(["partial_failure"]);
    expect(result.applications[0]?.items).toHaveLength(2);
    expect(baseSchema.safeParse(result).success).toBe(true);
  });

  it("does not add a second partial_failure error when one was supplied", () => {
    const supplied = createToolError({ code: "partial_failure", message: "one item failed" });
    const result = buildToolResult({
      applications: [okOutcome("sonarr"), failedOutcome("radarr")],
      errors: [supplied],
    });

    expect(result.errors).toEqual([supplied]);
  });

  it("reports an error-only envelope when no application was reached at all", () => {
    const result = buildToolResult({
      errors: [createToolError({ code: "invalid_input", message: "the variant is not declared" })],
    });

    expect(result.status).toBe("error");
    expect(result.applications).toEqual([]);
    expect(baseSchema.safeParse(result).success).toBe(true);
  });

  it("carries plan, job, and receipt detail only on mutation envelopes", () => {
    const mutation = {
      requestedEffects: [
        {
          application: "sonarr" as const,
          severity: "destructive" as const,
          summary: "delete file",
        },
      ],
      predictedEffects: [],
      plan: "pln_00000001",
      receipt: { reference: "apl_00000001", state: "outcome_unknown" as const },
    };
    const result = buildToolResult({ applications: [okOutcome("sonarr")], mutation });

    expect(mutationSchema.safeParse(result).success).toBe(true);
    expect(baseSchema.safeParse(result).success).toBe(false);
  });

  it("rejects an envelope with an undeclared field or an unknown status", () => {
    const result = buildToolResult({ applications: [okOutcome("sonarr")] });

    expect(baseSchema.safeParse({ ...result, extra: true }).success).toBe(false);
    expect(baseSchema.safeParse({ ...result, status: "maybe" }).success).toBe(false);
  });

  it("only declares a data payload where a payload can actually be produced", () => {
    const withData = buildToolResult({
      applications: [applicationOutcome({ application: "sonarr", status: "ok", data: {} })],
    });

    expect(baseSchema.safeParse(withData).success).toBe(false);
    expect(capabilitiesOutputSchema.safeParse(withData).success).toBe(false);
  });

  it("summarizes the envelope without introducing any new content", () => {
    const result = buildToolResult({
      applications: [okOutcome("sonarr"), failedOutcome("radarr")],
      warnings: ["prowlarr is not configured"],
    });

    const summary = summarizeToolResult("arr_activity_query", result);
    expect(summary).toBe(
      "arr_activity_query: partial; sonarr ok, radarr unavailable; errors: partial_failure; 1 warning(s)",
    );
  });
});
