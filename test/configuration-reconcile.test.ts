import { describe, expect, it } from "vitest";
import type { ConfigurationDomain } from "../src/adapters/configuration/domains.js";
import {
  type ConfigurationReconcileOutcome,
  type ConfigurationReconcileRequest,
  runConfigurationReconciliation,
} from "../src/adapters/configuration/reconcile.js";
import { type ApplicationId, describeApplication } from "../src/applications.js";
import { fingerprintReadSet } from "../src/state/plans.js";
import { toolErrorProvesNoEffect } from "../src/tools/errors.js";
import { configurationHarness } from "./support/configuration.js";
import { fixtureBody, jsonResponse } from "./support/library.js";

/**
 * Desired-state reconciliation, read and written against recorded upstream
 * payloads.
 *
 * The assertions that matter most here are about what the *upstream request*
 * carries, not about what the caller is told: these APIs replace a whole
 * resource, so the proof that nothing was erased is the body that was sent. A
 * planted credential is expected to appear there unchanged and nowhere in the
 * outcome, which is the pair of claims a full-resource write has to make good
 * on at once.
 */

type Record_ = Record<string, unknown>;

interface Instance {
  /** Upstream route, without the versioned API prefix, to its response body. */
  readonly routes: Readonly<Record<string, unknown>>;
}

interface Dispatched {
  readonly method: string;
  readonly route: string;
  readonly body?: unknown;
}

interface ReconcileRun {
  readonly outcome: ConfigurationReconcileOutcome;
  readonly dispatched: readonly Dispatched[];
}

/**
 * Runs one reconciliation against a small routing table.
 *
 * A route the table does not carry answers 404, like an instance that does not
 * have that record; a PUT echoes what it was sent, like an instance that
 * accepted it.
 */
async function reconcile(
  application: ApplicationId,
  instance: Instance,
  request: ConfigurationReconcileRequest,
): Promise<ReconcileRun> {
  const prefix = `${describeApplication(application).apiBasePath}/`;
  const dispatched: Dispatched[] = [];
  const harness = configurationHarness(application, (call) => {
    const route = call.url.pathname.startsWith(prefix)
      ? call.url.pathname.slice(prefix.length)
      : call.url.pathname;
    const method = call.init.method ?? "GET";
    const sent = typeof call.init.body === "string" ? JSON.parse(call.init.body) : undefined;
    dispatched.push({ method, route, ...(sent === undefined ? {} : { body: sent }) });
    if (method !== "GET") {
      return jsonResponse(sent);
    }
    const body = instance.routes[route];
    return body === undefined
      ? jsonResponse({ message: "NotFound" }, 404)
      : jsonResponse(structuredClone(body));
  });

  const outcome = await runConfigurationReconciliation(application, harness.client, request);
  return { outcome, dispatched };
}

function planning(
  domain: ConfigurationDomain,
  targetId: number,
  overrides: Partial<ConfigurationReconcileRequest> = {},
): ConfigurationReconcileRequest {
  return { domain, targetId, fields: [], mode: "plan", ...overrides };
}

function expectPlanned(outcome: ConfigurationReconcileOutcome) {
  if (outcome.status !== "planned") {
    throw new Error(
      `Expected a plan, got ${outcome.status === "error" ? outcome.error.message : outcome.status}`,
    );
  }
  return outcome;
}

function expectApplied(outcome: ConfigurationReconcileOutcome) {
  if (outcome.status !== "applied") {
    throw new Error(
      `Expected an apply, got ${outcome.status === "error" ? outcome.error.message : outcome.status}`,
    );
  }
  return outcome;
}

function expectRefused(outcome: ConfigurationReconcileOutcome) {
  if (outcome.status !== "error") {
    throw new Error(`Expected a refusal, got ${outcome.status}`);
  }
  return outcome;
}

function writes(dispatched: readonly Dispatched[]): readonly Dispatched[] {
  return dispatched.filter((call) => call.method !== "GET");
}

function onlyWrite(dispatched: readonly Dispatched[]): Dispatched {
  const [write, ...rest] = writes(dispatched);
  if (write === undefined || rest.length > 0) {
    throw new Error(`Expected exactly one upstream write, saw ${writes(dispatched).length}`);
  }
  return write;
}

async function first(application: ApplicationId, route: string): Promise<Record_> {
  const body = await fixtureBody<readonly Record_[]>(application, route);
  const record = body[0];
  if (record === undefined) {
    throw new Error(`The recorded ${route} response is empty`);
  }
  return record;
}

describe("planning a desired state", () => {
  it("describes the change without sending anything upstream", async () => {
    const indexer = await first("sonarr", "indexer");
    const { outcome, dispatched } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": indexer } },
      planning("indexers", 1, {
        fields: [
          { name: "priority", value: 30 },
          { name: "categories", value: [5030] },
        ],
      }),
    );
    const planned = expectPlanned(outcome);

    expect(writes(dispatched)).toEqual([]);
    expect(planned.changed).toBe(true);
    expect(planned.diff.ref).toEqual({ application: "sonarr", domain: "indexers", id: "1" });
    expect(planned.diff.changes).toEqual([
      { path: "fields.categories", action: "set", before: [5030, 5040], after: [5030] },
      { path: "priority", action: "set", before: 25, after: 30 },
    ]);
    // Every credential on the resource, and what this write does to it.
    expect(planned.diff.secrets).toEqual([{ name: "apiKey", disposition: "preserved" }]);
    // Everything the desired state did not name: the whole resource less the
    // dynamic field array, less the one property and the one field written.
    expect(planned.diff.preserved).toEqual({
      properties: Object.keys(indexer).length - 2,
      fields: (indexer.fields as readonly unknown[]).length - 1,
    });
  });

  it("reports a field already in the requested state as unchanged", async () => {
    const indexer = await first("sonarr", "indexer");
    const { outcome, dispatched } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": indexer } },
      planning("indexers", 1, { fields: [{ name: "priority", value: 25 }] }),
    );
    const planned = expectPlanned(outcome);

    expect(planned.changed).toBe(false);
    expect(planned.diff.changes).toEqual([
      { path: "priority", action: "unchanged", before: 25, after: 25 },
    ]);
    expect(writes(dispatched)).toEqual([]);
  });

  it("discloses every enable switch a provider carries", async () => {
    const indexer = await first("sonarr", "indexer");
    const { outcome } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": indexer } },
      planning("indexers", 1, { fields: [{ name: "enabled", value: true }] }),
    );
    const planned = expectPlanned(outcome);

    expect(planned.diff.changes.map((entry) => entry.path)).toEqual([
      "enableRss",
      "enableAutomaticSearch",
      "enableInteractiveSearch",
    ]);
    expect(planned.warnings).toContain(
      "enabling this provider turns on every search switch it reports, including any that were off",
    );
  });
});

describe("a full-resource write", () => {
  it("sends the whole recorded resource back with only the named fields changed", async () => {
    const indexer = await first("sonarr", "indexer");
    const { outcome, dispatched } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": indexer } },
      planning("indexers", 1, {
        mode: "apply",
        fields: [
          { name: "priority", value: 30 },
          { name: "categories", value: [5030] },
        ],
      }),
    );
    const applied = expectApplied(outcome);
    const write = onlyWrite(dispatched);

    expect(applied.attempted).toBe(true);
    expect(write.route).toBe("indexer/1");
    expect(write.method).toBe("PUT");
    // Byte for byte the recorded resource, with two values replaced: the
    // properties this server does not model, the dynamic fields it withholds,
    // and the field entries' own metadata all survive because nothing rebuilt
    // them.
    expect(write.body).toEqual({
      ...indexer,
      priority: 30,
      fields: (indexer.fields as readonly Record_[]).map((field) =>
        field.name === "categories" ? { ...field, value: [5030] } : field,
      ),
    });
  });

  it("keeps the planted credential in the upstream request and out of the outcome", async () => {
    const indexer = await first("sonarr", "indexer");
    const canary = (indexer.fields as readonly Record_[]).find(
      (field) => field.name === "apiKey",
    )?.value;
    expect(typeof canary).toBe("string");

    const { outcome, dispatched } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": indexer } },
      planning("indexers", 1, { mode: "apply", fields: [{ name: "priority", value: 30 }] }),
    );
    expectApplied(outcome);

    // The credential goes back exactly as it arrived — a full-resource update
    // that omitted it would erase it — and appears in nothing the caller reads.
    expect(JSON.stringify(onlyWrite(dispatched).body)).toContain(canary);
    expect(JSON.stringify(outcome)).not.toContain(canary);
  });

  it("returns a masked secret unchanged rather than blanking it", async () => {
    const applications = await fixtureBody<readonly Record_[]>("prowlarr", "applications");
    const masked = applications[1];
    if (masked === undefined) {
      throw new Error("The recorded Prowlarr application list has no masked entry");
    }
    const maskedValue = (masked.fields as readonly Record_[]).find(
      (field) => field.name === "apiKey",
    )?.value;
    expect(maskedValue).toBe("********");

    const { outcome, dispatched } = await reconcile(
      "prowlarr",
      { routes: { "applications/2": masked } },
      planning("applications", 2, {
        mode: "apply",
        fields: [{ name: "name", value: "Renamed Application" }],
      }),
    );
    const applied = expectApplied(outcome);
    const sent = onlyWrite(dispatched).body as Record_;

    // The sentinel is what this application accepts back to mean "keep the
    // stored credential", so sending it unchanged is what preserves it.
    expect((sent.fields as readonly Record_[])[1]).toEqual({
      order: 1,
      name: "apiKey",
      value: "********",
      privacy: "apiKey",
    });
    expect(sent.name).toBe("Renamed Application");
    expect(applied.diff.secrets).toEqual([{ name: "apiKey", disposition: "preserved" }]);
  });

  it("preserves a profile's ordered entries and the scores it was not asked about", async () => {
    // Ordering is asserted against an inline payload for the reason the
    // observation tests give: the recorded profiles carry empty item lists.
    const profile = {
      id: 1,
      name: "Example HD",
      upgradeAllowed: true,
      cutoff: 9,
      items: [
        { quality: { id: 9, name: "HDTV-1080p" }, items: [], allowed: true },
        { quality: { id: 1, name: "SDTV" }, items: [], allowed: false },
      ],
      formatItems: [{ format: 1, name: "Example Format", score: 100 }],
      minFormatScore: 0,
      cutoffFormatScore: 0,
    };
    const { outcome, dispatched } = await reconcile(
      "sonarr",
      { routes: { "qualityprofile/1": profile } },
      planning("quality_profiles", 1, {
        mode: "apply",
        fields: [
          { name: "name", value: "Example HD Renamed" },
          { name: "minFormatScore", value: 20 },
        ],
      }),
    );
    expectApplied(outcome);

    expect(onlyWrite(dispatched).body).toEqual({
      ...profile,
      name: "Example HD Renamed",
      minFormatScore: 20,
    });
  });
});

describe("explicit removal", () => {
  it("clears only what was named and leaves an omitted field alone", async () => {
    const client = await first("radarr", "downloadclient");
    const password = (client.fields as readonly Record_[]).find(
      (field) => field.name === "password",
    )?.value;
    const { outcome, dispatched } = await reconcile(
      "radarr",
      { routes: { "downloadclient/1": client } },
      planning("download_clients", 1, {
        mode: "apply",
        removeFields: ["movieCategory", "password"],
      }),
    );
    const applied = expectApplied(outcome);
    const sent = onlyWrite(dispatched).body as Record_;
    const sentFields = sent.fields as readonly Record_[];
    const fieldValue = (name: string) => sentFields.find((field) => field.name === name)?.value;

    expect(fieldValue("movieCategory")).toBeNull();
    expect(fieldValue("password")).toBeNull();
    // Never named, never touched: an omitted field is preserved rather than
    // being inferred to be a removal.
    expect(fieldValue("initialState")).toBe(0);
    expect(fieldValue("username")).toBe("example-operator");
    expect(JSON.stringify(sent)).not.toContain(password);

    expect(applied.diff.changes).toEqual([
      { path: "fields.movieCategory", action: "clear", before: "radarr" },
      { path: "fields.password", action: "clear", redacted: true },
    ]);
    expect(applied.diff.secrets).toEqual([
      { name: "username", disposition: "preserved" },
      { name: "password", disposition: "cleared" },
    ]);
    expect(applied.warnings).toContain(
      "clearing a credential leaves this record without it until one is supplied again",
    );
  });

  it("refuses to clear a field the record does not carry", async () => {
    const indexer = await first("sonarr", "indexer");
    const { outcome, dispatched } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": indexer } },
      planning("indexers", 1, { mode: "apply", removeFields: ["seedRatio"] }),
    );

    expect(expectRefused(outcome).error).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("has no seedRatio field"),
    });
    expect(writes(dispatched)).toEqual([]);
  });
});

describe("dependency validation", () => {
  it("refuses a desired state that names a tag the application does not report", async () => {
    const indexer = await first("sonarr", "indexer");
    const tags = await fixtureBody("sonarr", "tag");
    const { outcome, dispatched } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": indexer, tag: tags } },
      planning("indexers", 1, { mode: "apply", fields: [{ name: "tags", value: [3, 99] }] }),
    );

    expect(expectRefused(outcome).error).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("no tag with identifier 99"),
    });
    expect(expectRefused(outcome).attempted).toBe(false);
    expect(writes(dispatched)).toEqual([]);
  });

  it("writes a tag list the application does report", async () => {
    const indexer = await first("sonarr", "indexer");
    const tags = await fixtureBody("sonarr", "tag");
    const { outcome, dispatched } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": indexer, tag: tags } },
      planning("indexers", 1, { mode: "apply", fields: [{ name: "tags", value: [3, 4] }] }),
    );
    expectApplied(outcome);

    expect((onlyWrite(dispatched).body as Record_).tags).toEqual([3, 4]);
  });

  it("stores the instance's own root-folder path for the identifier a list names", async () => {
    const list = await first("sonarr", "importlist");
    const { outcome, dispatched } = await reconcile(
      "sonarr",
      {
        routes: {
          "importlist/1": list,
          qualityprofile: await fixtureBody("sonarr", "qualityprofile"),
          rootfolder: await fixtureBody("sonarr", "rootfolder"),
        },
      },
      planning("import_lists", 1, {
        mode: "apply",
        fields: [
          { name: "qualityProfileId", value: 2 },
          { name: "rootFolderId", value: 2 },
        ],
      }),
    );
    const applied = expectApplied(outcome);
    const sent = onlyWrite(dispatched).body as Record_;

    expect(sent.qualityProfileId).toBe(2);
    expect(sent.rootFolderPath).toBe("/media/example/archive");
    expect(applied.diff.changes).toEqual([
      { path: "qualityProfileId", action: "set", before: 1, after: 2 },
      {
        path: "rootFolderPath",
        action: "set",
        before: "/media/example/series",
        after: "/media/example/archive",
      },
    ]);
  });

  it("refuses a root folder the application does not report", async () => {
    const list = await first("sonarr", "importlist");
    const { outcome } = await reconcile(
      "sonarr",
      {
        routes: {
          "importlist/1": list,
          rootfolder: await fixtureBody("sonarr", "rootfolder"),
        },
      },
      planning("import_lists", 1, {
        mode: "apply",
        fields: [{ name: "rootFolderId", value: 9 }],
      }),
    );

    expect(expectRefused(outcome).error).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("no root folder with identifier 9"),
    });
  });
});

describe("applying a recorded plan", () => {
  it("refuses as stale when a field the plan observed has moved", async () => {
    const indexer = await first("sonarr", "indexer");
    const request = planning("indexers", 1, { fields: [{ name: "priority", value: 30 }] });
    const { outcome } = await reconcile("sonarr", { routes: { "indexer/1": indexer } }, request);
    const planned = expectPlanned(outcome);

    const moved = { ...indexer, priority: 40 };
    const { outcome: stale, dispatched } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": moved } },
      { ...request, mode: "apply", planned: fingerprintReadSet(planned.observations) },
    );

    expect(expectRefused(stale).error).toMatchObject({
      code: "stale_plan",
      message: expect.stringContaining("priority"),
    });
    expect(writes(dispatched)).toEqual([]);
  });

  it("refuses as stale when a dependency the plan pointed at is gone", async () => {
    const indexer = await first("sonarr", "indexer");
    const tags = await fixtureBody<readonly Record_[]>("sonarr", "tag");
    const request = planning("indexers", 1, { fields: [{ name: "tags", value: [3] }] });
    const { outcome } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": indexer, tag: tags } },
      request,
    );
    const planned = expectPlanned(outcome);

    const { outcome: stale } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": indexer, tag: tags.filter((tag) => tag.id !== 3) } },
      { ...request, mode: "apply", planned: fingerprintReadSet(planned.observations) },
    );

    // A deleted pointer is staleness, not a bad argument: the caller cannot fix
    // arguments it did not get wrong.
    expect(expectRefused(stale).error).toMatchObject({ code: "stale_plan" });
  });

  it("applies a plan whose observed state has not moved", async () => {
    const indexer = await first("sonarr", "indexer");
    const request = planning("indexers", 1, { fields: [{ name: "priority", value: 30 }] });
    const { outcome } = await reconcile("sonarr", { routes: { "indexer/1": indexer } }, request);
    const planned = expectPlanned(outcome);

    // An unrelated property moving does not expire the plan: the read set names
    // what this mutation depends on and nothing else.
    const unrelated = { ...indexer, seasonSearchMaximumSingleEpisodeAge: 30 };
    const { outcome: applied, dispatched } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": unrelated } },
      { ...request, mode: "apply", planned: fingerprintReadSet(planned.observations) },
    );

    expect(expectApplied(applied).attempted).toBe(true);
    expect((onlyWrite(dispatched).body as Record_).priority).toBe(30);
  });
});

describe("what an apply reports", () => {
  it("sends nothing when the record already matches the desired state", async () => {
    const indexer = await first("sonarr", "indexer");
    const { outcome, dispatched } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": indexer } },
      planning("indexers", 1, { mode: "apply", fields: [{ name: "priority", value: 25 }] }),
    );
    const applied = expectApplied(outcome);

    expect(applied.attempted).toBe(false);
    expect(applied.changed).toBe(false);
    expect(applied.warnings).toContain(
      "this record already matches the desired state; nothing was sent",
    );
    expect(writes(dispatched)).toEqual([]);
  });

  it("reports a record the application no longer has as a stale reference", async () => {
    const { outcome } = await reconcile(
      "sonarr",
      { routes: {} },
      planning("indexers", 9, { mode: "apply", fields: [{ name: "priority", value: 25 }] }),
    );
    const refused = expectRefused(outcome);

    expect(refused.error.code).toBe("stale_reference");
    expect(refused.attempted).toBe(false);
  });

  it("does not claim a dispatched write was unattempted when it failed", async () => {
    const indexer = await first("sonarr", "indexer");
    const prefix = `${describeApplication("sonarr").apiBasePath}/`;
    const harness = configurationHarness("sonarr", (call) =>
      (call.init.method ?? "GET") === "GET"
        ? jsonResponse(indexer)
        : jsonResponse({ message: `${call.url.pathname.slice(prefix.length)} failed` }, 500),
    );
    const outcome = await runConfigurationReconciliation(
      "sonarr",
      harness.client,
      planning("indexers", 1, { mode: "apply", fields: [{ name: "priority", value: 30 }] }),
    );
    const refused = expectRefused(outcome);

    expect(refused.attempted).toBe(true);
    // The request was sent and its answer could not be read, so the failure
    // proves nothing about what the instance did with it.
    expect(toolErrorProvesNoEffect(refused.error.code)).toBe(false);
  });

  it("refuses a domain the application does not model before sending anything", async () => {
    const { outcome, dispatched } = await reconcile(
      "prowlarr",
      { routes: {} },
      planning("root_folders", 1, { mode: "apply", fields: [{ name: "name", value: "anything" }] }),
    );

    expect(expectRefused(outcome).error.code).toBe("unsupported_capability");
    expect(dispatched).toEqual([]);
  });
});
