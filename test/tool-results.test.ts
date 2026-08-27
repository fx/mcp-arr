import { describe, expect, it } from "vitest";
import {
  createToolError,
  toolErrorForThrown,
  toolErrorForUpstreamFailure,
} from "../src/tools/errors.js";
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

  it("summarizes a partial result with the failure's code and remediation", () => {
    const result = buildToolResult({
      applications: [okOutcome("sonarr"), failedOutcome("radarr")],
      warnings: ["prowlarr is not configured"],
    });

    // The successful half and the failed half both have to be readable from
    // the text alone, because a host that surfaces only the text would
    // otherwise show a failure it cannot act on.
    expect(summarizeToolResult("arr_activity_query", result)).toBe(
      "arr_activity_query: partial; sonarr ok, radarr unavailable; errors: unavailable_application (Confirm the instance is running and reachable, then retry; other applications are unaffected.), partial_failure (Inspect the per-application and per-item outcomes and retry only the failures.); 1 warning(s)",
    );
  });

  it("summarizes a total failure with the code the envelope's error list omits", () => {
    const result = buildToolResult({
      applications: [failedOutcome("sonarr"), failedOutcome("radarr")],
    });

    // Nothing succeeded, so there is no top-level error to summarize from; the
    // cause lives on each application, and one shared code is named once.
    expect(result.errors).toEqual([]);
    expect(summarizeToolResult("arr_activity_query", result)).toBe(
      "arr_activity_query: error; sonarr unavailable, radarr unavailable; errors: unavailable_application (Confirm the instance is running and reachable, then retry; other applications are unaffected.)",
    );
  });

  it("summarizes an unsupported variant by naming the capability remediation", () => {
    const unsupported = (application: "sonarr" | "prowlarr") =>
      applicationOutcome({
        application,
        status: "unsupported",
        error: createToolError({
          code: "unsupported_capability",
          message: `${application}: this operation is declared but not implemented yet`,
          application,
        }),
      });
    const result = buildToolResult({
      applications: [unsupported("sonarr"), unsupported("prowlarr")],
    });

    expect(summarizeToolResult("arr_library_query", result)).toBe(
      "arr_library_query: error; sonarr unsupported, prowlarr unsupported; errors: unsupported_capability (Call arr_capabilities to list the operations this instance supports.)",
    );
  });

  it("summarizes a success without any error segment", () => {
    const result = buildToolResult({ applications: [okOutcome("sonarr"), okOutcome("radarr")] });

    expect(summarizeToolResult("arr_activity_query", result)).toBe(
      "arr_activity_query: ok; sonarr ok, radarr ok",
    );
  });

  it("names an item failure's code without repeating it per item", () => {
    const staleItem = (reference: string): ItemOutcome => ({
      reference,
      status: "error",
      warnings: [],
      error: createToolError({
        code: "stale_reference",
        message: "the queue reference expired",
        application: "sonarr",
      }),
    });
    const result = buildToolResult({
      applications: [
        applicationOutcome({
          application: "sonarr",
          status: "ok",
          items: [staleItem("que_00000001"), staleItem("que_00000002")],
        }),
      ],
    });

    expect(summarizeToolResult("arr_queue_resolve", result)).toBe(
      "arr_queue_resolve: partial; sonarr ok (2 item(s) failed); errors: stale_reference (Repeat the query that produced the reference and use the fresh one.), partial_failure (Inspect the per-application and per-item outcomes and retry only the failures.)",
    );
  });

  it("keeps upstream content out of the summary even when an error carries it", () => {
    // The HTTP boundary redacts before an error is built, so this message is
    // deliberately hostile: it proves the summary is safe because of what it
    // restates, not because every message it might meet is already clean.
    const secret = "b0bacafe00000000000000000000beef";
    const upstream = toolErrorForUpstreamFailure(
      {
        kind: "validation",
        message: `sonarr rejected the request: {"path":"https://sonarr.example.invalid/api/v3/series?apikey=${secret}","body":"<html>denied</html>","header":"X-Api-Key: ${secret}"}`,
      },
      "sonarr",
    );
    const thrown = toolErrorForThrown(
      new Error(`connect ECONNREFUSED https://radarr.example.invalid?apikey=${secret}`),
      "radarr",
    );
    const result = buildToolResult({
      applications: [
        applicationOutcome({ application: "sonarr", status: "error", error: upstream }),
        applicationOutcome({ application: "radarr", status: "error", error: thrown }),
      ],
    });

    const summary = summarizeToolResult("arr_library_change", result);

    // The summary restates only the closed-vocabulary code and its static
    // hint, so no field an upstream response can influence has a route into
    // the text — while the structured result still carries the full message.
    expect(summary).toBe(
      "arr_library_change: error; sonarr error, radarr error; errors: upstream_rejection (Adjust the requested values to satisfy the application's own validation.), unexpected_response (Check the application version against arr_capabilities and report the mismatch.)",
    );
    for (const leak of [
      secret,
      "sonarr.example.invalid",
      "radarr.example.invalid",
      "<html>",
      "X-Api-Key",
      "apikey",
    ]) {
      expect(summary).not.toContain(leak);
    }
    expect(result.applications[0]?.error?.message).toContain(secret);
    expect(result.applications[1]?.error?.message).not.toContain(secret);
  });

  it("reports how much a bounded read returned", () => {
    const page = (returned: number, hasMore: boolean) =>
      buildToolResult({
        applications: [
          applicationOutcome({
            application: "sonarr",
            status: "ok",
            continuation: { pageSize: 25, returned, hasMore },
          }),
        ],
      });

    // An empty page and a full one must not read the same, or a wrong filter
    // is indistinguishable from a working query.
    expect(summarizeToolResult("arr_library_query", page(0, false))).toBe(
      "arr_library_query: ok; sonarr ok (0 record(s))",
    );
    expect(summarizeToolResult("arr_library_query", page(25, true))).toBe(
      "arr_library_query: ok; sonarr ok (25 record(s), more available)",
    );
  });

  it("lets a tool word its own summary and falls back when it declines", () => {
    const result = buildToolResult({
      applications: [applicationOutcome({ application: "sonarr", status: "ok", data: {} })],
    });

    expect(
      summarizeToolResult("arr_capabilities", result, {
        lead: () => "no application available",
        outcome: () => "unavailable",
      }),
    ).toBe("arr_capabilities: no application available; sonarr unavailable");

    // A hook that declines leaves the envelope's own wording in place, so a
    // tool never has to describe an outcome it does not recognize.
    expect(
      summarizeToolResult("arr_capabilities", result, {
        lead: () => undefined,
        outcome: () => undefined,
      }),
    ).toBe(summarizeToolResult("arr_capabilities", result));
  });
});
