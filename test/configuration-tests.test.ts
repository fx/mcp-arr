import { beforeAll, describe, expect, it } from "vitest";
import type { ProviderDomain } from "../src/adapters/configuration/domains.js";
import { providerDomains } from "../src/adapters/configuration/domains.js";
import {
  classifyTest,
  describeExternalEffect,
  externalEffectOf,
  isBypassable,
  planBypass,
  providerTestOutcomes,
  providerTestRoute,
  readValidation,
  runProviderTest,
  type ValidationFinding,
} from "../src/adapters/configuration/tests.js";
import { fixtureBody, jsonResponse, libraryHarness, type UpstreamCall } from "./support/library.js";

/**
 * Provider tests and the one bypass that may follow a warned one.
 *
 * The recorded fixture is a real validation answer carrying both kinds of
 * finding at once — a warning and an error — which is the shape that decides
 * every classification below. The single-kind answers are taken from it rather
 * than invented, so a change to what the instance actually says moves all of
 * them together.
 */

let recorded: readonly Record<string, unknown>[] = [];

beforeAll(async () => {
  recorded = (await fixtureBody("sonarr", "notification/test")) as Record<string, unknown>[];
});

function warningOnly(): readonly unknown[] {
  return recorded.filter((finding) => finding.isWarning === true);
}

function errorOnly(): readonly unknown[] {
  return recorded.filter((finding) => finding.isWarning !== true);
}

interface Answer {
  readonly status: number;
  readonly body?: unknown;
}

interface Instance {
  readonly calls: UpstreamCall[];
  readonly client: Parameters<typeof runProviderTest>[1];
  readonly bodies: Record<string, unknown>[];
  run(domain?: ProviderDomain): ReturnType<typeof runProviderTest>;
}

/** An instance answering a provider test with one recorded shape. */
function instance(answer: Answer, options: { unreachable?: boolean } = {}): Instance {
  const bodies: Record<string, unknown>[] = [];
  const harness = libraryHarness("sonarr", (call) => {
    const raw = typeof call.init.body === "string" ? call.init.body : "{}";
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    if (options.unreachable === true) {
      throw new Error("connection reset");
    }
    return answer.body === undefined
      ? new Response(null, { status: answer.status })
      : jsonResponse(answer.body, answer.status);
  });

  return {
    calls: harness.calls,
    client: harness.client,
    bodies,
    run: (domain = "notifications") =>
      runProviderTest("sonarr", harness.client, {
        domain,
        payload: { id: 1, name: "Example Notification", implementation: "Webhook" },
      }),
  };
}

function ok(result: Awaited<ReturnType<typeof runProviderTest>>) {
  if (result.status !== "ok") {
    throw new Error(`Expected a completed test, got ${result.error.code}`);
  }
  return result;
}

function failed(result: Awaited<ReturnType<typeof runProviderTest>>) {
  if (result.status !== "error") {
    throw new Error(`Expected an error, got ${result.status}`);
  }
  return result;
}

describe("external effects", () => {
  it("declares what testing each provider family reaches", () => {
    // Every domain has an answer, so a family added later cannot be tested
    // without someone deciding what its test does outside the instance.
    expect(providerDomains.map(externalEffectOf).length).toBe(providerDomains.length);
    expect(externalEffectOf("notifications")).toBe("delivers_message");
    for (const domain of providerDomains.filter((one) => one !== "notifications")) {
      expect(externalEffectOf(domain), domain).toBe("contacts_service");
    }
  });

  it("says before a notification test that a person receives something", () => {
    // The distinction a caller needs is whether somebody is on the other end: a
    // delivered message cannot be taken back and a connection attempt can be
    // forgotten.
    expect(describeExternalEffect("notifications", "sonarr")).toContain(
      "delivers a real notification",
    );
    expect(describeExternalEffect("indexers", "sonarr")).toContain("contact the external service");
    expect(describeExternalEffect("indexers", "sonarr")).not.toContain("notification");
  });

  it("reports afterwards what the test that ran actually reached", async () => {
    const delivered = ok(await instance({ status: 200 }).run("notifications"));
    const contacted = ok(await instance({ status: 200 }).run("indexers"));

    // Reported as a fact about what happened, not only predicted beforehand: a
    // caller reading the result alone still learns a message went out.
    expect(delivered.effect).toBe("delivers_message");
    expect(delivered.attempted).toBe(true);
    expect(contacted.effect).toBe("contacts_service");
  });

  it("names the route each domain's test is sent to", () => {
    expect(providerTestRoute("notifications", "sonarr")).toBe("notification/test");
    expect(providerTestRoute("proxies", "prowlarr")).toBe("indexerproxy/test");
    // A domain the application does not model has no test route at all.
    expect(providerTestRoute("proxies", "sonarr")).toBeUndefined();
    expect(providerTestRoute("import_lists", "prowlarr")).toBeUndefined();
  });

  it("refuses a domain the application does not model without contacting it", async () => {
    const running = instance({ status: 200 });
    const result = failed(await running.run("proxies"));

    expect(result.error.code).toBe("unsupported_capability");
    expect(result.attempted).toBe(false);
    expect(running.calls).toEqual([]);
  });
});

describe("classifying a test", () => {
  it("keeps passing, warned, and failed as three answers", () => {
    expect(providerTestOutcomes).toEqual(["passed", "warned", "failed"]);
    const warning: ValidationFinding = { severity: "warning", message: "example" };
    const error: ValidationFinding = { severity: "error", message: "example" };
    const read = (findings: readonly ValidationFinding[], unreadable = 0) => ({
      findings,
      unreadable,
    });

    expect(classifyTest(true, read([]))).toBe("passed");
    expect(classifyTest(true, read([warning]))).toBe("warned");
    expect(classifyTest(false, read([warning]))).toBe("warned");
    expect(classifyTest(false, read([error]))).toBe("failed");
    // One error among warnings is a failure. Reading the set as warnings
    // because most of them were is exactly how a bypass comes to override
    // something it was never meant to.
    expect(classifyTest(false, read([warning, error]))).toBe("failed");
    expect(classifyTest(true, read([warning, error]))).toBe("failed");
  });

  it("treats an objection it cannot read as one a bypass must not override", () => {
    const warning: ValidationFinding = { severity: "warning", message: "example" };

    // A refusal listing nothing readable is a failure, and so is one listing a
    // warning beside something unread: the unread part is exactly what a bypass
    // would be overriding blind.
    expect(classifyTest(false, { findings: [], unreadable: 0 })).toBe("failed");
    expect(classifyTest(false, { findings: [], unreadable: 1 })).toBe("failed");
    expect(classifyTest(false, { findings: [warning], unreadable: 1 })).toBe("failed");
    // An accepted answer already says the instance took it, so an unreadable
    // entry beside that is a warning nobody can name rather than a refusal.
    expect(classifyTest(true, { findings: [], unreadable: 1 })).toBe("warned");
  });

  it("counts what it could not read rather than dropping it", () => {
    expect(readValidation(undefined)).toEqual({ findings: [], unreadable: 0 });
    // A body that is not a list at all is one unreadable objection, not none.
    expect(readValidation({ message: "not a list" })).toEqual({ findings: [], unreadable: 1 });
    expect(readValidation([{ propertyName: "onGrab" }])).toEqual({ findings: [], unreadable: 1 });
    expect(
      readValidation([{ errorMessage: "example", isWarning: true }, { propertyName: "onGrab" }]),
    ).toEqual({
      findings: [{ severity: "warning", field: undefined, message: "example" }],
      unreadable: 1,
    });
  });

  it("counts an entry as a warning only where the instance said so", () => {
    // Unlabelled is an error: being wrong that way refuses a save that could
    // have proceeded, and being wrong the other way overrides a real failure.
    expect(readValidation([{ errorMessage: "example" }]).findings).toEqual([
      { severity: "error", field: undefined, message: "example" },
    ]);
    expect(readValidation([{ errorMessage: "example", severity: "notice" }]).findings).toEqual([
      { severity: "error", field: undefined, message: "example" },
    ]);
    expect(readValidation([{ errorMessage: "example", isWarning: true }]).findings).toEqual([
      { severity: "warning", field: undefined, message: "example" },
    ]);
    expect(readValidation([{ errorMessage: "example", severity: "Warning" }]).findings).toEqual([
      { severity: "warning", field: undefined, message: "example" },
    ]);
  });

  it("reads the recorded answer into both kinds of finding", async () => {
    const result = ok(await instance({ status: 400, body: recorded }).run());

    expect(result.unreadable).toBe(0);
    expect(result.findings).toEqual([
      {
        severity: "warning",
        field: "onGrab",
        message: "Notifications on grab are enabled but no grab events are selected",
      },
      {
        severity: "error",
        field: "webHookUrl",
        message: "Unable to connect to the configured endpoint",
      },
    ]);
    expect(result.outcome).toBe("failed");
  });
});

describe("running a test", () => {
  it("reports a clean test as passed with nothing to say", async () => {
    const running = instance({ status: 200 });
    const result = ok(await running.run());

    expect(result.outcome).toBe("passed");
    expect(result.findings).toEqual([]);
    expect(running.calls[0]?.url.pathname).toBe("/api/v3/notification/test");
    expect(running.calls[0]?.init.method).toBe("POST");
    expect(running.bodies[0]).toMatchObject({ id: 1, implementation: "Webhook" });
  });

  it("reads a refusal rather than losing it, because the refusal is the answer", async () => {
    const result = ok(await instance({ status: 400, body: warningOnly() }).run());

    // A caller that only learned the status could report that the instance
    // refused the test and never why, nor whether it was a warning.
    expect(result.outcome).toBe("warned");
    expect(result.findings.map((finding) => finding.severity)).toEqual(["warning"]);
  });

  it("reports a hard validation failure as failed", async () => {
    const result = ok(await instance({ status: 400, body: errorOnly() }).run());

    expect(result.outcome).toBe("failed");
    expect(result.findings[0]).toMatchObject({ severity: "error", field: "webHookUrl" });
  });

  it("reports an unreachable instance as an error that may still have delivered", async () => {
    const running = instance({ status: 200 }, { unreachable: true });
    const result = failed(await running.run());

    // The request went out. A test whose answer was lost may well have sent its
    // notification, so this says it was attempted rather than that nothing
    // happened.
    expect(result.attempted).toBe(true);
    expect(result.error.code).toBe("unavailable_application");
    expect(running.bodies).toHaveLength(1);
    // And it says what the attempt reached, so a caller does not retry a
    // notification that may already have been delivered.
    expect(result.effect).toBe("delivers_message");
  });

  it("carries no external effect where nothing was attempted", async () => {
    const result = failed(await instance({ status: 200 }).run("proxies"));

    expect(result.attempted).toBe(false);
    expect(result.effect).toBeUndefined();
  });

  it("reports a payload the client refused as never having been sent", async () => {
    const running = instance({ status: 200 });
    const circular: Record<string, unknown> = { id: 1 };
    circular.self = circular;
    const result = failed(
      await runProviderTest("sonarr", running.client, {
        domain: "notifications",
        payload: circular,
      }),
    );

    // The client refuses a payload it cannot serialize before it reaches for
    // the instance, so nothing was delivered and nothing may be claimed. A flag
    // set beside the call would have reported a notification sent for a payload
    // that never left this process.
    expect(running.calls).toEqual([]);
    expect(result.attempted).toBe(false);
    expect(result.effect).toBeUndefined();
    expect(result.error.code).toBe("invalid_input");
  });

  it("still fails a server error rather than reading it as a validation answer", async () => {
    const result = failed(await instance({ status: 500, body: warningOnly() }).run());

    // Above 500 the instance is reporting that it failed, not that the request
    // did, and that is not an answer to hand back as a validation result.
    expect(result.error.code).toBe("unexpected_response");
    expect(result.attempted).toBe(true);
  });
});

describe("bypassing warnings", () => {
  const warned = { severity: "warning" as const, field: "onGrab", message: "example warning" };
  const base = {
    findings: [warned],
    unreadable: 0,
    effect: "delivers_message" as const,
    attempted: true,
  };

  it("permits a bypass past warnings and refuses one past a failure", () => {
    expect(isBypassable("warned")).toBe(true);
    expect(isBypassable("failed")).toBe(false);
    expect(isBypassable("passed")).toBe(false);

    const permitted = planBypass("sonarr", { ...base, outcome: "warned" });
    expect(permitted.refusal).toBeUndefined();
    // The parameter is emitted only because something needed overriding, and
    // only ever as true.
    expect(permitted.query).toEqual({ forceSave: true });

    const refused = planBypass("sonarr", { ...base, outcome: "failed" });
    expect(refused.refusal?.code).toBe("upstream_rejection");
    expect(refused.refusal?.message).toContain("does not override a failure");
    // A refused bypass sends nothing and claims nothing.
    expect(refused.query).toEqual({});
    expect(refused.warnings).toEqual([]);
  });

  it("says nothing was skipped where nothing was raised", () => {
    const clean = planBypass("sonarr", { ...base, outcome: "passed", findings: [] });

    // The caller asked for a save and it would have succeeded, so it is not
    // refused — but sending the parameter or claiming that checks were skipped
    // would describe something that did not happen.
    expect(clean.refusal).toBeUndefined();
    expect(clean.query).toEqual({});
    expect(clean.warnings).toEqual([expect.stringContaining("nothing was skipped")]);
    expect(clean.warnings.join(" ")).not.toContain("skipped the instance's validation warnings");
  });

  it("names every warning it skipped rather than counting them", async () => {
    const result = ok(await instance({ status: 400, body: warningOnly() }).run());
    const decided = planBypass("sonarr", result);

    // A bypass that reported only how many warnings there were would let a
    // caller record having overridden something without recording what.
    expect(decided.warnings[0]).toContain("skipped the instance's validation warnings");
    expect(decided.warnings[1]).toContain("onGrab");
    expect(decided.warnings[1]).toContain("no grab events are selected");
    expect(decided.warnings).toHaveLength(2);
  });

  it("describes only the warnings, never an error it did not skip", () => {
    const decided = planBypass("sonarr", {
      ...base,
      outcome: "warned",
      findings: [
        { severity: "warning", message: "a skipped warning" },
        { severity: "error", message: "a failure nothing skipped" },
      ],
    });

    expect(decided.warnings.join(" ")).toContain("a skipped warning");
    expect(decided.warnings.join(" ")).not.toContain("a failure nothing skipped");
  });

  it("says which objections nobody could read where that is why it refused", () => {
    const unread = planBypass("sonarr", { ...base, outcome: "failed", unreadable: 2 });

    expect(unread.refusal?.message).toContain("2 objection(s) this server could not read");
  });
});

describe("disclosure", () => {
  it("keeps the tested provider's own payload out of the result", async () => {
    const canary = "CANARY-PROVIDER-TEST-SECRET-0008";
    const harness = libraryHarness("sonarr", () => jsonResponse(recorded, 400));
    const result = ok(
      await runProviderTest("sonarr", harness.client, {
        domain: "notifications",
        payload: { id: 1, fields: [{ name: "apiKey", value: canary }] },
      }),
    );

    // The findings are the instance's own words about what failed, which is
    // what a caller needs; the resource that was tested is not, and it carries
    // the credential.
    const published = JSON.stringify(result);
    expect(published).not.toContain(canary);
    expect(published).not.toContain("example.invalid");
    expect(published).toContain("Unable to connect");
  });
});
