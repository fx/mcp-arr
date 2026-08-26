import { describe, expect, it } from "vitest";
import { UpstreamError, upstreamErrorKinds } from "../src/http/errors.js";
import {
  createToolError,
  isRecoverableToolErrorCode,
  toolErrorCodeForUpstreamKind,
  toolErrorCodes,
  toolErrorForThrown,
  toolErrorForUpstreamFailure,
  toolErrorPolicy,
  toolErrorSchema,
} from "../src/tools/errors.js";

const apiKey = "sonarr-secret-key";

describe("tool error contract", () => {
  it("can construct every stable code with a conforming shape", () => {
    for (const code of toolErrorCodes) {
      const error = createToolError({ code, message: `${code} happened`, application: "sonarr" });
      expect(toolErrorSchema.safeParse(error).success, code).toBe(true);
      expect(error.code).toBe(code);
      expect(error.application).toBe("sonarr");
    }
  });

  it("carries a remediation hint on every code and marks the recoverable ones", () => {
    const recoverable = toolErrorCodes.filter(isRecoverableToolErrorCode);

    for (const code of toolErrorCodes) {
      const policy = toolErrorPolicy(code);
      expect(policy.remediation.length, code).toBeGreaterThan(0);
      expect(createToolError({ code, message: code }).remediation).toBe(policy.remediation);
      expect(createToolError({ code, message: code }).recoverable).toBe(policy.recoverable);
    }

    expect(recoverable).toContain("stale_reference");
    expect(recoverable).toContain("rate_limit");
    expect(recoverable).toContain("timeout");
    expect(recoverable).not.toContain("unsupported_capability");
  });

  it("omits the application rather than serializing an undefined field", () => {
    const error = createToolError({ code: "invalid_input", message: "bad arguments" });
    expect("application" in error).toBe(false);
    expect(JSON.stringify(error)).not.toContain("application");
  });

  it("maps every upstream failure kind onto a stable code", () => {
    const mapped = upstreamErrorKinds.map((kind) => [kind, toolErrorCodeForUpstreamKind(kind)]);

    expect(mapped).toEqual([
      ["invalid-request", "invalid_input"],
      ["unavailable", "unavailable_application"],
      ["timeout", "timeout"],
      ["authentication", "upstream_authentication"],
      ["validation", "upstream_rejection"],
      ["not-found", "stale_reference"],
      ["rate-limit", "rate_limit"],
      ["unexpected-response", "unexpected_response"],
    ]);
    for (const [, code] of mapped) {
      expect(toolErrorCodes).toContain(code);
    }
  });

  it("reuses the upstream boundary's redacted message for a normalized failure", () => {
    const upstream = new UpstreamError("authentication", {
      application: "sonarr",
      operation: "system/status",
      status: 401,
    });

    const error = toolErrorForUpstreamFailure(upstream, "sonarr");
    expect(error.code).toBe("upstream_authentication");
    expect(error.message).toBe(upstream.message);
    expect(error.application).toBe("sonarr");
    expect(toolErrorSchema.safeParse(error).success).toBe(true);
  });

  it("normalizes a thrown upstream error and refuses to echo any other one", () => {
    const upstream = new UpstreamError("rate-limit", { application: "prowlarr", status: 429 });
    expect(toolErrorForThrown(upstream)).toMatchObject({
      code: "rate_limit",
      application: "prowlarr",
    });

    const leaky = new Error(`GET https://sonarr.example.invalid/api/v3?apikey=${apiKey} failed`);
    const normalized = toolErrorForThrown(leaky, "sonarr");

    expect(normalized.code).toBe("unexpected_response");
    expect(normalized.message).toBe("sonarr: the request failed unexpectedly");
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("sonarr.example.invalid");
    expect(serialized).not.toContain("at Object");
  });

  it("keeps a thrown non-error value out of the normalized message", () => {
    const normalized = toolErrorForThrown({ secret: apiKey });
    expect(normalized.message).toBe("the request failed unexpectedly");
    expect(JSON.stringify(normalized)).not.toContain(apiKey);
  });
});
