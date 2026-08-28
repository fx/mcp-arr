import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { findToolDefinition } from "../src/tools/definitions.js";
import { type ToolName, toolNames } from "../src/tools/names.js";
import { describePayloadPaths, payloadInventory } from "../src/tools/schemas/publish-results.js";
import {
  assertWellFormed,
  declaredPropertyValues,
  publishedPropertyNames,
  schemaFailures,
} from "./support/json-schema.js";
import { assertCleanProtocolStdout, spawnBuiltServer } from "./support/spawned-stdio.js";
import { sampleBranchInputs } from "./support/tool-context.js";

const sonarrApiKey = "sonarr-secret-key";

/**
 * The built server rejects startup without a complete instance pair, and the
 * reserved `.invalid` host guarantees that no request in this file can reach a
 * real instance.
 */
const configuredInstance = {
  SONARR_URL: "https://sonarr.example.invalid/sonarr",
  SONARR_API_KEY: sonarrApiKey,
};

function spawnServer(deadlineMs = 5_000) {
  return spawnBuiltServer(configuredInstance, deadlineMs);
}

interface PublishedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

interface ToolListResult {
  result?: { tools?: PublishedTool[] };
}

interface PublishedListing {
  readonly tools: readonly PublishedTool[];
  /** What the listing cost on the wire, framing included. */
  readonly bytes: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The bytes one response occupied on the wire, its newline delimiter included.
 *
 * Read off the raw stdout rather than re-serialized from the decoded message,
 * because the number this file pins is what a host actually receives. A
 * re-serialization would be measuring this test's own `JSON.stringify` instead
 * of the server's, and dropping the delimiter would measure the payload rather
 * than the message.
 */
function responseBytes(stdout: string, id: number): number {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate !== "" && (JSON.parse(candidate) as { id?: number }).id === id);
  if (line === undefined) {
    throw new Error(`The spawned server sent no response for request ${id}`);
  }
  return Buffer.byteLength(`${line}\n`, "utf8");
}

async function readPublishedTools(): Promise<PublishedListing> {
  const child = spawnServer();
  try {
    await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
    const listed = (await child.request(2, "tools/list")) as ToolListResult;
    await child.terminateGracefully();
    return {
      tools: listed.result?.tools ?? [],
      bytes: responseBytes(child.stdout, 2),
      stdout: child.stdout,
      stderr: child.stderr,
    };
  } finally {
    await child.forceCleanup().catch(() => undefined);
  }
}

let listing: Promise<PublishedListing> | undefined;

/**
 * The published tool definitions, exactly as a host receives them: read back
 * off the wire from a spawned server rather than converted in process, because
 * an in-process conversion is what hid an empty published schema behind a
 * passing suite.
 *
 * Read once and shared by every assertion in this file that is about the
 * listing. They all ask the same server the same question, so spawning it once
 * per assertion would only spend seconds proving the answer is stable.
 */
function publishedTools(): Promise<PublishedListing> {
  listing ??= readPublishedTools();
  return listing;
}

async function publishedInputSchemas(): Promise<ReadonlyMap<string, Record<string, unknown>>> {
  const { tools } = await publishedTools();
  return new Map(tools.map((tool) => [tool.name, tool.inputSchema ?? {}]));
}

/**
 * The combinators a host drops a tool for carrying at the root of its input
 * schema. All three, and the root only: the same host never inspects a
 * combinator nested under a property.
 */
const rootCombinators = ["anyOf", "oneOf", "allOf"] as const;

/** The property-key shape a host requires of a published schema, at any depth. */
const propertyKeyPattern = /^[a-zA-Z0-9_.-]{1,64}$/u;

/**
 * The most the published listing may cost on the wire, in bytes.
 *
 * Every session pays this before making a single call, so its size is part of
 * the contract rather than an implementation detail. The number is a recorded
 * measurement plus a margin, not a budget somebody chose: it was read off a
 * spawned server at 57,686 bytes.
 *
 * The margin is sized against what it has to catch. The cheapest way for the
 * bulk to come back is one tool publishing its payload schema again, and the
 * smallest of those is `arr_job_get`'s at 1,431 bytes — so a margin under that
 * cannot hide even the least expensive regression, while still leaving room for
 * a tool description or a few payload fields. Raising it is a deliberate act,
 * which is the point: a change that reintroduces bulk fails here rather than
 * merely being regrettable.
 */
const listingByteCeiling = 58_500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface VariantLine {
  /** The discriminator values this form's label lists, empty when it has none. */
  readonly values: readonly string[];
  /** The arguments the form requires, its own discriminator value included. */
  readonly required: ReadonlySet<string>;
  /** Every argument the form names, required or optional. */
  readonly names: ReadonlySet<string>;
}

/** The argument names one comma-separated part names, annotations stripped. */
function argumentNames(part: string): string[] {
  return part
    .split(",")
    .map((argument) => argument.trim().split("=")[0]?.trim() ?? "")
    .filter((name) => name !== "");
}

/**
 * Reads one generated variant line back into the form it describes.
 *
 * The grammar is fixed: an optional `<discriminator>=<value>|<value>` label,
 * the required arguments after `: `, the optional ones after `; optional `, and
 * any argument may carry an `=<narrowing>` annotation. Parsing it is what keeps
 * the expectations below derived from what the server published — matching
 * literal text would restate the variant list this whole mechanism exists to
 * stop maintaining by hand.
 */
function parseVariantLine(line: string, discriminator: string | undefined): VariantLine {
  const [head = "", optional = ""] = line.slice(2).split("; optional ");
  let label = "";
  let requiredPart = head;
  if (discriminator !== undefined && head.startsWith(`${discriminator}=`)) {
    const separator = head.indexOf(": ");
    label = separator === -1 ? head : head.slice(0, separator);
    requiredPart = separator === -1 ? "" : head.slice(separator + 2);
  }
  const required = new Set(argumentNames(requiredPart));
  if (label !== "" && discriminator !== undefined) {
    required.add(discriminator);
  }
  return {
    values: label === "" ? [] : label.slice(label.indexOf("=") + 1).split("|"),
    required,
    names: new Set([...required, ...argumentNames(optional)]),
  };
}

interface ToolCallResult {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: {
      status?: string;
      errors?: Array<{ code?: string; remediation?: string }>;
      applications?: Array<{
        application: string;
        status: string;
        data?: { state?: string };
        error?: { code?: string; remediation?: string };
      }>;
    };
  };
}

describe("built stdio tool surface", () => {
  it("publishes the fourteen tools with their schemas and keeps stdout clean", async () => {
    const { tools, stdout, stderr } = await publishedTools();

    expect(tools.map((tool) => tool.name)).toEqual([...toolNames]);
    for (const tool of tools) {
      expect(tool.inputSchema?.type, tool.name).toBe("object");
      // A root combinator is not a style question. A host that filters tool
      // definitions drops the tool outright when it finds one, so publishing
      // alternatives at the root costs a caller the whole tool rather than
      // some of its detail — and the object root the protocol asks for is
      // satisfied at the same time as the combinator is present, which is how
      // thirteen tools passed the assertion above while being unusable.
      for (const combinator of rootCombinators) {
        expect(
          tool.inputSchema?.[combinator],
          `${tool.name} publishes a root ${combinator}`,
        ).toBeUndefined();
      }
      // Closed at the root as well: a caller reading the schema has to be
      // able to tell that a property it does not find there is one the tool
      // does not accept.
      expect(tool.inputSchema?.additionalProperties, tool.name).toBe(false);
      assertWellFormed(tool.inputSchema ?? {}, tool.name);
      // An object root satisfied on its own is what let every variant tool
      // publish `{"type":"object","properties":{}}`, so the arguments have to
      // be asserted here rather than beside this: a tool that publishes no
      // argument name tells a caller nothing it can send.
      const published = [...publishedPropertyNames(tool.inputSchema)];
      expect(published, `${tool.name} publishes no argument`).not.toHaveLength(0);
      expect(
        published.filter((key) => !propertyKeyPattern.test(key)),
        `${tool.name} property key shape`,
      ).toEqual([]);
      const discriminator = findToolDefinition(tool.name as ToolName)?.discriminator;
      if (discriminator !== undefined) {
        expect(published, tool.name).toContain(discriminator);
      }

      expect(tool.outputSchema?.type, tool.name).toBe("object");
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.annotations, tool.name).toBeDefined();
    }

    assertCleanProtocolStdout(stdout);
    expect(stderr).toBe("");
  });

  it("keeps the whole listing under its recorded byte ceiling", async () => {
    const { bytes } = await publishedTools();

    expect(bytes, `tools/list is ${bytes} bytes`).toBeLessThanOrEqual(listingByteCeiling);
  });

  it("publishes a broadened envelope carrying each payload's generated paths", async () => {
    const { tools } = await publishedTools();

    for (const tool of tools) {
      const schema = tool.outputSchema ?? {};
      assertWellFormed(schema, `${tool.name} output`);
      // Open at the root, so `mutation` — which every mutation tool returns
      // and this schema does not declare — stays valid for a host that checks
      // structured content against what was published.
      expect(schema.additionalProperties, `${tool.name} closed output root`).not.toBe(false);

      const outcomes = isRecord(schema.properties) ? schema.properties.applications : undefined;
      const outcome = isRecord(outcomes) && isRecord(outcomes.items) ? outcomes.items : {};
      const declared = isRecord(outcome.properties) ? outcome.properties : {};
      // Where `data` sits is the one thing below the root that is published,
      // because a path into a payload is written relative to it.
      expect(Object.keys(declared), `${tool.name} outcome`).toEqual(["data"]);
      // And nothing below it: the payload's fields are the generated prose.
      expect(declared.data, `${tool.name} data`).toEqual({});

      // The inventory a caller reads is the one this process generates, so
      // what is advertised and what a projection will resolve cannot be two
      // different things.
      const definition = findToolDefinition(tool.name as ToolName);
      const inventory =
        definition === undefined ? undefined : payloadInventory(definition.outputSchema);
      expect(schema.description, `${tool.name} inventory`).toBe(
        inventory === undefined ? undefined : describePayloadPaths(inventory),
      );
    }
  });

  it("publishes a schema that admits every variant each tool accepts and refuses what it rejects", async () => {
    const published = await publishedInputSchemas();

    for (const name of toolNames) {
      const schema = published.get(name);
      expect(schema, name).toBeDefined();
      if (schema === undefined) {
        continue;
      }
      const definition = findToolDefinition(name);
      expect(definition, name).toBeDefined();

      const discriminator = definition?.discriminator;
      if (discriminator !== undefined) {
        // The variant is the half that never reached the wire. A published
        // schema carrying no alternative admits any value here. Asserted once
        // per tool rather than once per branch: the claim is about the value
        // set the root publishes for one property, which is the same set
        // whichever form the rest of the object came from.
        const undeclaredVariant = {
          ...sampleBranchInputs[name][0],
          [discriminator]: "not_a_variant",
        };
        expect(schemaFailures(schema, undeclaredVariant), `${name} undeclared variant`).not.toEqual(
          [],
        );
      }

      for (const branch of sampleBranchInputs[name]) {
        // One variant per entry, rather than one sample per tool: a flat
        // published root no longer names the variants, so whether it admits
        // what the tool accepts is a question about each of them separately.
        const accepted = structuredClone(branch) as Record<string, unknown>;
        const where = `${name} ${JSON.stringify(accepted)}`;
        expect(schemaFailures(schema, accepted), `${where} published`).toEqual([]);
        // Both directions of the same claim. The published schema being looser
        // than validation is the accepted trade-off; being looser in a way that
        // admits something validation refuses would make it a false contract.
        expect(definition?.inputSchema.safeParse(accepted).success, `${where} validated`).toBe(
          true,
        );

        // The same object with one property the tool does not declare. The tool
        // refuses it at runtime, so a published schema that admits it would tell
        // a host something untrue about the call.
        const rejected = { ...accepted, unexpectedProperty: "value" };
        expect(schemaFailures(schema, rejected), `${where} unknown property`).not.toEqual([]);
      }
    }
  });

  it("carries a sample for every variant the published schema declares", async () => {
    const published = await publishedInputSchemas();

    for (const name of toolNames) {
      const schema = published.get(name);
      const properties = isRecord(schema?.properties) ? schema.properties : {};
      const branches = sampleBranchInputs[name];
      const discriminator = findToolDefinition(name)?.discriminator;

      if (discriminator !== undefined) {
        // The set the samples exercise against the set the schema advertises.
        // Without this the table above is a list somebody has to remember to
        // extend, and the variant nobody extends it for is the one that goes
        // unchecked.
        const sampled = branches
          .map((branch) => branch[discriminator])
          .filter((value) => value !== undefined);
        expect([...new Set(sampled)].sort(), `${name} sampled variants`).toEqual(
          [...declaredPropertyValues(schema ?? {}, discriminator)].sort(),
        );
      }

      // A tool that publishes `plan` accepts the apply-from-plan form, which
      // carries no discriminator value and so is invisible to the check above.
      // Exactly one, because two would mean a form was counted twice; at least
      // one direct form beside it, because a tool whose only sample is the plan
      // reference exercises none of its intents.
      if ("plan" in properties) {
        expect(
          branches.filter((branch) => "plan" in branch),
          `${name} plan-reference samples`,
        ).toHaveLength(1);
        expect(
          branches.filter((branch) => !("plan" in branch)).length,
          `${name} direct-form samples`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("documents every variant it merged away in the published description", async () => {
    const published = await publishedInputSchemas();

    for (const name of toolNames) {
      const schema = published.get(name);
      const properties = isRecord(schema?.properties) ? schema.properties : {};
      const branches = sampleBranchInputs[name];
      const discriminator = findToolDefinition(name)?.discriminator;

      // A tool with one form merged nothing away and has nothing to recover.
      if (branches.length < 2) {
        expect(schema?.description, `${name} documents a variant it does not have`).toBeUndefined();
        continue;
      }

      const description = schema?.description;
      expect(typeof description, `${name} description`).toBe("string");
      if (typeof description !== "string") {
        continue;
      }
      // The one thing a flat root cannot say for itself, and the reason the
      // rest of the description is not merely helpful: the published properties
      // are the union of the forms, so a caller has to be told not to combine
      // two of them.
      expect(description, name).toContain(
        "Supply exactly one of these forms in full; do not combine properties from two forms.",
      );

      const lines = description
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => parseVariantLine(line, discriminator));
      expect(lines.length, `${name} documented forms`).toBeGreaterThan(0);

      if (discriminator !== undefined) {
        // Every advertised value is reachable from the prose, so a caller
        // reading the enum can always find the form that goes with it.
        const documented = new Set(lines.flatMap((line) => line.values));
        expect([...documented].sort(), `${name} documented variants`).toEqual(
          [...declaredPropertyValues(schema ?? {}, discriminator)].sort(),
        );
      }

      // Every published property is attributed to at least one form, and every
      // name the prose uses is a property the root really publishes. The root
      // properties are the union of the forms', so these two sets are the same
      // set — which makes this the check that a form's optional arguments are
      // documented too, something minimal per-branch samples cannot show.
      expect([...new Set(lines.flatMap((line) => [...line.names]))].sort(), name).toEqual(
        Object.keys(properties).sort(),
      );

      for (const branch of branches) {
        const argumentNames = Object.keys(branch);
        const value = discriminator === undefined ? undefined : branch[discriminator];
        const line =
          value === undefined
            ? lines.find((candidate) => argumentNames.every((key) => candidate.names.has(key)))
            : lines.find((candidate) => candidate.values.includes(value as string));
        expect(line, `${name} ${JSON.stringify(branch)} has no documented form`).toBeDefined();
        // Every argument this variant is accepted with is named on its own
        // line, so what a form needs is readable without sending a call and
        // reading the rejection.
        expect([...(line?.names ?? [])], `${name} ${JSON.stringify(branch)}`).toEqual(
          expect.arrayContaining(argumentNames),
        );
      }

      if ("plan" in properties) {
        // The replacement for the published-schema assertion that used to live
        // in the arr_library_change stdio suite: a plan reference replaces the
        // intent rather than accompanying it, and a flat root publishes both as
        // independent optional properties, so the prose is now the only place
        // that says so.
        const planLines = lines.filter((line) => line.required.has("plan"));
        expect(planLines, `${name} plan-reference form`).toHaveLength(1);
        if (discriminator !== undefined) {
          expect(planLines[0]?.names.has(discriminator), `${name} plan-reference form`).toBe(false);
        }
      }
    }

    // Pinned by name, and the only expectation here that is: the narrowest
    // correlation the merge discards, and the one no derived check above can
    // make. `arr_activity_change`'s two intents name the same arguments and
    // differ only in the kind of reference `records` takes, so the reference
    // annotation is the whole of what tells them apart. Lose it — by the
    // published pattern drifting out from under the reverse lookup that
    // produces it, say — and the two signatures become identical, the forms
    // collapse onto one line, and the distinction disappears from the published
    // documentation rather than failing anywhere.
    const recordAnnotations = String(published.get("arr_activity_change")?.description ?? "")
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => /\brecords=([^,;]+)/u.exec(line)?.[1])
      .filter((annotation): annotation is string => annotation !== undefined);
    expect(new Set(recordAnnotations).size, "arr_activity_change records annotations").toBe(2);
  });

  it("returns the unsupported_capability error without contacting an instance", async () => {
    const child = spawnServer();

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const called = (await child.request(2, "tools/call", {
        name: "arr_library_query",
        arguments: { view: "movies", applications: ["sonarr"] },
      })) as ToolCallResult;

      expect(called.result?.isError).toBe(true);
      expect(called.result?.structuredContent?.status).toBe("error");
      const outcomes = called.result?.structuredContent?.applications ?? [];
      expect(outcomes.map((outcome) => [outcome.application, outcome.error?.code])).toEqual([
        ["sonarr", "unsupported_capability"],
      ]);
      expect(outcomes[0]?.error?.remediation).toBeTruthy();
      expect(called.result?.content?.[0]?.type).toBe("text");

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarrApiKey);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("answers both job tools locally with clean stdout and no upstream request", async () => {
    const child = spawnServer();

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      // A freshly started server holds no job, so a syntactically valid
      // reference is by definition one this process never issued. Answering it
      // is entirely process-local: nothing is probed, and the envelope still
      // conforms to the tool's published output schema.
      const read = (await child.request(2, "tools/call", {
        name: "arr_job_get",
        arguments: { job: "job_00000001" },
      })) as ToolCallResult;
      const cancelled = (await child.request(3, "tools/call", {
        name: "arr_job_cancel",
        arguments: { mode: "apply", job: "job_00000001" },
      })) as ToolCallResult;

      for (const called of [read, cancelled]) {
        expect(called.result?.isError).toBe(true);
        expect(called.result?.structuredContent?.status).toBe("error");
        expect(called.result?.structuredContent?.errors?.map((error) => error.code)).toEqual([
          "stale_reference",
        ]);
        expect(called.result?.structuredContent?.errors?.[0]?.remediation).toBeTruthy();
        expect(called.result?.content?.[0]?.type).toBe("text");
      }

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarrApiKey);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("answers arr_capabilities with structured content for every application", async () => {
    const child = spawnServer(20_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      // Only Sonarr is configured and its reserved `.invalid` host cannot
      // resolve, so the report is deterministic: one unreachable instance and
      // two unconfigured ones, with the whole result still succeeding.
      const called = (await child.request(2, "tools/call", {
        name: "arr_capabilities",
        arguments: {},
      })) as ToolCallResult;

      expect(called.result?.isError).toBe(false);
      expect(called.result?.structuredContent?.status).toBe("ok");
      expect(
        (called.result?.structuredContent?.applications ?? []).map((outcome) => [
          outcome.application,
          outcome.status,
          outcome.data?.state,
        ]),
      ).toEqual([
        ["sonarr", "ok", "unavailable"],
        ["radarr", "ok", "unconfigured"],
        ["prowlarr", "ok", "unconfigured"],
      ]);
      // The summary has to agree with the structured half. Asserting only that
      // it mentions the tool name is what let it claim "sonarr ok" while the
      // report beside it said the instance was unreachable.
      expect(called.result?.content?.[0]?.text).toBe(
        "arr_capabilities: no application available; sonarr unavailable, radarr unconfigured, prowlarr unconfigured",
      );

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarrApiKey);
      expect(child.stdout).not.toContain("sonarr.example.invalid");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);
});
