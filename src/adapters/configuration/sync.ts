import { z } from "zod";
import type { ApplicationId } from "../../applications.js";
import type { UpstreamBody, UpstreamClient } from "../../http/client.js";
import { UpstreamError } from "../../http/errors.js";
import {
  compareReadSet,
  fingerprintReadSet,
  type ReadSetFingerprint,
  type ReadSetObservation,
} from "../../state/plans.js";
import { createToolError, type ToolError, toolErrorForThrown } from "../../tools/errors.js";
import { routeFor } from "./domains.js";
import { type ConfigurationRef, configurationRef } from "./model.js";
import { isUpstreamRecord, parseCollection, parseConfiguration } from "./parse.js";
import { captureUpstreamResource, type UpstreamResource, type UpstreamValue } from "./resources.js";

/**
 * Prowlarr application synchronization.
 *
 * Prowlarr does not hold indexers for its own sake: it pushes them into the
 * Sonarr and Radarr instances it is mapped to, and each mapping decides for
 * itself how much of that push it performs. This module models that decision
 * and nothing else — it reads the mappings, the indexers, and the tags that
 * connect them, and answers what changing a mapping's sync level would do to
 * the indexers on the other side.
 *
 * Three rules hold throughout.
 *
 * Everything here is derived from what Prowlarr itself reports. This server
 * does not read the target application's indexer list and does not claim to
 * know what is on it: an effect is what Prowlarr *would do*, which is what a
 * caller needs before flipping a level that can delete, and an effect is
 * labelled proposed rather than certain wherever only Prowlarr can settle it.
 *
 * A mapping never silently stops mattering. Where a level cannot carry an
 * effect out — an add-only mapping cannot refresh, a disabled one does nothing
 * at all — the affected indexers are reported as stale rather than omitted,
 * because the remote keeps whatever it already had and a caller reading a
 * shorter list would conclude the opposite.
 *
 * And nothing here is atomic. Prowlarr synchronizes each mapping separately, so
 * a call naming several gets an outcome for each; a partial result is the
 * normal case rather than an error path, and this module never collapses one
 * into a success or a total failure.
 */

/** The sync levels this server models, in the vocabulary its callers use. */
export const syncLevels = ["disabled", "add_only", "full_sync"] as const;

export type SyncLevel = (typeof syncLevels)[number];

/**
 * Prowlarr's own spelling of each level.
 *
 * The table is exhaustive in both directions and is the only place either
 * vocabulary is written down. A level upstream reports that is not in it is not
 * translated to the nearest one: this module's whole output is a claim about
 * what a level will do, and a guess about which level a mapping is on would
 * make that claim about the wrong one.
 */
const upstreamSyncLevels: Readonly<Record<SyncLevel, string>> = {
  disabled: "disabled",
  add_only: "addOnly",
  full_sync: "fullSync",
};

export function upstreamSyncLevel(level: SyncLevel): string {
  return upstreamSyncLevels[level];
}

export function readSyncLevel(value: string | null | undefined): SyncLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return syncLevels.find(
    (level) => upstreamSyncLevels[level].toLowerCase() === normalized || level === normalized,
  );
}

/**
 * What each level is permitted to do to the indexers on the other side.
 *
 * This table is the specification of the four behaviors, stated once. Every
 * effect below is decided by reading it rather than by testing the level again,
 * so a level cannot come to mean one thing in the plan and another in the
 * disclosure.
 */
export interface SyncCapability {
  /** Whether the level pushes indexers the remote does not have yet. */
  readonly adds: boolean;
  /** Whether it re-pushes an indexer whose definition in Prowlarr has moved on. */
  readonly updates: boolean;
  /** Whether it deletes an indexer on the remote that its selection excludes. */
  readonly removes: boolean;
}

export const syncCapabilities: Readonly<Record<SyncLevel, SyncCapability>> = {
  disabled: { adds: false, updates: false, removes: false },
  add_only: { adds: true, updates: false, removes: false },
  full_sync: { adds: true, updates: true, removes: true },
};

const applicationSchema = z.object({
  id: z.custom<number>((value) => typeof value === "number" && Number.isSafeInteger(value)),
  name: z.string().nullish(),
  implementation: z.string().nullish(),
  syncLevel: z.string().nullish(),
  tags: z.array(z.number()).nullish(),
});

const indexerSchema = z.object({
  id: z.custom<number>((value) => typeof value === "number" && Number.isSafeInteger(value)),
  name: z.string().nullish(),
  enable: z.boolean().nullish(),
  tags: z.array(z.number()).nullish(),
});

const tagSchema = z.object({
  id: z.custom<number>((value) => typeof value === "number" && Number.isSafeInteger(value)),
  label: z.string().nullish(),
});

/** One application mapping, reduced to what a sync decision turns on. */
export interface ApplicationMapping {
  readonly ref: ConfigurationRef;
  readonly id: number;
  readonly name: string;
  readonly implementation?: string | undefined;
  /** Absent when the instance reports a level this server does not model. */
  readonly level?: SyncLevel | undefined;
  readonly reportedLevel?: string | undefined;
  readonly tagIds: readonly number[];
  /** The untouched payload a level change is written over. */
  readonly resource: UpstreamResource;
}

/** One Prowlarr indexer, reduced to what decides whether a mapping carries it. */
export interface SyncIndexer {
  readonly ref: ConfigurationRef;
  readonly id: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly tagIds: readonly number[];
}

/** Everything one sync decision is read from, in one observation. */
export interface SyncObservation {
  readonly mappings: readonly ApplicationMapping[];
  readonly indexers: readonly SyncIndexer[];
  /** Tag identifiers to labels, for naming a selection without inventing one. */
  readonly tagLabels: ReadonlyMap<number, string>;
}

function text(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? undefined : trimmed;
}

function tagIdsOf(tags: readonly number[] | null | undefined): readonly number[] {
  return Array.isArray(tags) ? tags.filter((tag) => Number.isSafeInteger(tag)) : [];
}

async function readCollection(
  client: UpstreamClient,
  application: ApplicationId,
  route: string,
): Promise<readonly unknown[]> {
  return parseCollection(await client.get(route), application, route);
}

/**
 * Reads the mappings, the indexers, and the tags in one pass.
 *
 * All three are read together because a sync decision is a statement about how
 * they relate: which indexers a mapping's tags select, and what that selection
 * is called. Reading them at different moments would let the plan describe a
 * relationship that never held at any single instant.
 */
export async function readSyncObservation(
  application: ApplicationId,
  client: UpstreamClient,
): Promise<SyncObservation> {
  const applicationsRoute = routeFor("applications", application);
  const indexerRoute = routeFor("indexers", application);
  const tagRoute = routeFor("tags", application);
  if (applicationsRoute === undefined || indexerRoute === undefined || tagRoute === undefined) {
    throw new UpstreamError("unexpected-response", { application, operation: "applications" });
  }

  const [applicationBodies, indexerBodies, tagBodies] = await Promise.all([
    readCollection(client, application, applicationsRoute),
    readCollection(client, application, indexerRoute),
    readCollection(client, application, tagRoute),
  ]);

  const mappings = applicationBodies.map((body): ApplicationMapping => {
    const parsed = parseConfiguration(applicationSchema, body, application, applicationsRoute);
    const reported = text(parsed.syncLevel);
    return {
      ref: configurationRef(application, "applications", parsed.id),
      id: parsed.id,
      name: text(parsed.name) ?? `application ${String(parsed.id)}`,
      implementation: text(parsed.implementation),
      level: readSyncLevel(parsed.syncLevel),
      reportedLevel: reported,
      tagIds: tagIdsOf(parsed.tags),
      resource: captureUpstreamResource(application, "applications", body as UpstreamValue),
    };
  });

  const indexers = indexerBodies.map((body): SyncIndexer => {
    const parsed = parseConfiguration(indexerSchema, body, application, indexerRoute);
    return {
      ref: configurationRef(application, "indexers", parsed.id),
      id: parsed.id,
      name: text(parsed.name) ?? `indexer ${String(parsed.id)}`,
      // Absent means enabled: Prowlarr omits the flag on an indexer it has
      // never disabled, and reading that omission as "disabled" would report
      // every such indexer as excluded from every mapping.
      enabled: parsed.enable !== false,
      tagIds: tagIdsOf(parsed.tags),
    };
  });

  const tagLabels = new Map<number, string>();
  for (const body of tagBodies) {
    const parsed = parseConfiguration(tagSchema, body, application, tagRoute);
    const label = text(parsed.label);
    if (label !== undefined) {
      tagLabels.set(parsed.id, label);
    }
  }

  return { mappings, indexers, tagLabels };
}

/**
 * Whether one mapping's tag selection carries one indexer.
 *
 * Prowlarr's rule, stated once: a mapping with no tags carries every indexer,
 * and a mapping with tags carries the indexers sharing at least one of them. An
 * indexer Prowlarr has disabled is carried by none of them, which is decided
 * here rather than by each caller, so "selected" means the same thing
 * everywhere it is asked.
 */
export function selects(mapping: ApplicationMapping, indexer: SyncIndexer): boolean {
  if (!indexer.enabled) {
    return false;
  }
  return mapping.tagIds.length === 0 || mapping.tagIds.some((tag) => indexer.tagIds.includes(tag));
}

/** What a sync level change would do to one indexer on the other side. */
export const syncEffectKinds = ["add", "update", "remove", "stale"] as const;

export type SyncEffectKind = (typeof syncEffectKinds)[number];

export interface SyncEffect {
  readonly indexer: ConfigurationRef;
  readonly name: string;
  readonly effect: SyncEffectKind;
  /** Why this indexer gets this effect, in terms a caller can act on. */
  readonly reason: string;
}

/**
 * The effects of moving one mapping from its current level to another.
 *
 * The two levels are compared through {@link syncCapabilities} rather than by
 * name, so what an effect is depends only on what each level may do. An effect
 * the target level may not carry out is not dropped — it becomes stale, which
 * is the disclosure that the remote keeps something Prowlarr is no longer
 * maintaining.
 *
 * One indexer may draw two effects. Whether a selected indexer is added or
 * merely re-sent depends on what the remote already has, and this server does
 * not read that, so both are stated rather than one being guessed at.
 */
export function planSyncEffects(
  mapping: ApplicationMapping,
  indexers: readonly SyncIndexer[],
  desired: SyncLevel,
): readonly SyncEffect[] {
  const current = mapping.level;
  const before = current === undefined ? syncCapabilities.disabled : syncCapabilities[current];
  const after = syncCapabilities[desired];
  const effects: SyncEffect[] = [];

  for (const indexer of indexers) {
    const selected = selects(mapping, indexer);
    const base = { indexer: indexer.ref, name: indexer.name };

    // A selected indexer has two possible fates and this server cannot see which
    // applies, because it does not read the remote's list. Both are disclosed
    // rather than one being chosen: the addition is what happens if the remote
    // does not have it, and the update or the staleness is what happens if it
    // does. Collapsing them would hide an addition behind an update, and hide
    // it entirely on a mapping whose level is not changing.
    if (selected) {
      if (after.adds) {
        effects.push({
          ...base,
          effect: "add",
          reason: before.adds
            ? "this level puts the indexer on the remote if it is not there yet"
            : "this level begins synchronizing the indexer, which the current level does not, and puts it on the remote if it is not there yet",
        });
      }
      if (after.updates) {
        effects.push({
          ...base,
          effect: "update",
          reason:
            "if the remote already has it, this level re-sends it whenever its definition here changes",
        });
      } else {
        effects.push({
          ...base,
          effect: "stale",
          reason: after.adds
            ? "if the remote already has it, this level never re-sends it, so a later change here does not reach the remote"
            : "this level synchronizes nothing, so whatever the remote already holds for this indexer stays as it is",
        });
      }
      continue;
    }

    // Not selected: either disabled here, or outside the mapping's tags. Both
    // mean Prowlarr will not maintain it, and the level decides whether the
    // remote's copy is deleted or merely abandoned.
    const reason = indexer.enabled
      ? "this indexer is outside the mapping's tag selection"
      : "this indexer is disabled here, so no mapping carries it";
    if (after.removes) {
      effects.push({
        ...base,
        effect: "remove",
        reason: `${reason}, and this level deletes an excluded indexer from the remote`,
      });
      continue;
    }
    effects.push({
      ...base,
      effect: "stale",
      reason: before.removes
        ? `${reason}; the current level would have deleted it and this one leaves it in place`
        : `${reason}, and this level deletes nothing, so whatever the remote holds for it stays`,
    });
  }

  return effects;
}

/** How a mapping's tag selection reads, without inventing a name for it. */
export function describeSelection(
  mapping: ApplicationMapping,
  tagLabels: ReadonlyMap<number, string>,
): string {
  if (mapping.tagIds.length === 0) {
    return "every enabled indexer";
  }
  const named = mapping.tagIds.map((tag) => tagLabels.get(tag) ?? `tag ${String(tag)}`);
  return `enabled indexers tagged ${named.join(" or ")}`;
}

/**
 * The state one mapping's plan rests on.
 *
 * Two kinds of thing are here, and both have to be. The level and the tag
 * selection are what the effects are computed from, and every indexer's
 * identity, enabled state, and selection are what decided one effect each: an
 * indexer disabled while a removal was planned for it must make that plan stale
 * rather than be deleted on the strength of a plan that described a different
 * set.
 *
 * And every name this plan *discloses* is here too — the mapping's, each
 * indexer's, and the labels the tag selection reads as — because a read set
 * observes what its plan disclosed and not only what its request sends. A plan
 * approved for one mapping must not apply against a mapping that has since been
 * renamed into something else, even though no name is written upstream.
 */
export function syncObservations(
  mapping: ApplicationMapping,
  indexers: readonly SyncIndexer[],
  tagLabels: ReadonlyMap<number, string>,
): readonly ReadSetObservation[] {
  const tags = [...mapping.tagIds].sort((left, right) => left - right);
  return [
    {
      key: `application:${String(mapping.id)}`,
      value: {
        name: mapping.name,
        level: mapping.reportedLevel,
        tags,
        labels: tags.map((tag) => tagLabels.get(tag)),
      },
    },
    {
      key: `selection:${String(mapping.id)}`,
      value: indexers
        .map((indexer) => ({
          id: indexer.id,
          name: indexer.name,
          enabled: indexer.enabled,
          selected: selects(mapping, indexer),
        }))
        .sort((left, right) => left.id - right.id),
    },
  ];
}

/**
 * The command Prowlarr synchronizes its applications with.
 *
 * One name, written here and nowhere else. The command endpoint will start
 * anything an instance knows how to do, so what this server may name there is
 * the whole of the guarantee — and a sync is a consequential push into another
 * application, so it runs only when a caller asked for it explicitly.
 */
export const syncCommandName = "ApplicationIndexerSync";

/** The payload that starts one sync. It names no application: Prowlarr syncs all. */
export function syncCommandPayload(): UpstreamBody {
  return { name: syncCommandName };
}

/**
 * Writes a new sync level over the mapping the instance reported.
 *
 * The level is written over the untouched payload, so every field this project
 * does not model — the mapping's credentials, its category selections, whatever
 * a newer Prowlarr adds — survives, because no line here touches them. The
 * value written is Prowlarr's own spelling of the level, never the normalized
 * one this project's callers use.
 */
export function rewriteSyncLevel(mapping: ApplicationMapping, desired: SyncLevel): UpstreamBody {
  const payload = mapping.resource.payload();
  if (!isUpstreamRecord(payload)) {
    throw new UpstreamError("unexpected-response", {
      application: mapping.ref.application,
      operation: "applications",
    });
  }
  return { ...payload, syncLevel: upstreamSyncLevel(desired) };
}

/** One mapping this call named, and what happened to it. */
export interface SyncItemOutcome {
  readonly ref: ConfigurationRef;
  readonly name: string;
  readonly selection: string;
  readonly currentLevel?: SyncLevel | undefined;
  readonly desiredLevel: SyncLevel;
  readonly effects: readonly SyncEffect[];
  readonly changed: boolean;
  /**
   * Whether an upstream write was dispatched for this mapping.
   *
   * A proof rather than an inference: it is set where the request is sent and
   * nowhere else, so a caller settling a receipt can tell a mapping that was
   * never written from one whose answer never came back.
   */
  readonly attempted: boolean;
  /** Set once the write has been confirmed by re-reading the mapping. */
  readonly verified?: boolean | undefined;
  readonly error?: ToolError | undefined;
  readonly warnings: readonly string[];
}

export interface ApplicationSyncRequest {
  /** The application mappings this call names, each answered on its own. */
  readonly targets: readonly number[];
  readonly syncLevel: SyncLevel;
  /**
   * Whether to start a synchronization once the levels are written. Explicit
   * and never defaulted: a sync pushes indexers into another application, and a
   * level that can remove pushes deletions.
   */
  readonly startSync: boolean;
  readonly mode: "plan" | "apply";
  readonly planned?: readonly ReadSetFingerprint[] | undefined;
}

interface SyncOutcomeBase {
  readonly items: readonly SyncItemOutcome[];
  readonly observations: readonly ReadSetObservation[];
  readonly warnings: readonly string[];
}

export type ApplicationSyncOutcome =
  | ({ readonly status: "planned" } & SyncOutcomeBase)
  | ({
      readonly status: "applied";
      /**
       * How many upstream writes were dispatched, counted rather than inferred.
       *
       * Zero is what lets a caller record that nothing happened upstream. "Every
       * item failed" does not establish it: one mapping whose write timed out
       * produces exactly that, and the request was sent.
       */
      readonly dispatched: number;
      /** Set when a started sync could not be confirmed, never on its own. */
      readonly unresolved?: ToolError | undefined;
    } & SyncOutcomeBase)
  | { readonly status: "error"; readonly error: ToolError; readonly dispatched: number };

function failure(
  application: ApplicationId,
  code: "invalid_input" | "stale_reference" | "stale_plan" | "unsupported_capability" | "conflict",
  message: string,
): ToolError {
  return createToolError({ code, message: `${application}: ${message}`, application });
}

/**
 * Answers one application-sync reconciliation.
 *
 * Planning and applying run the same sequence — observe, resolve each named
 * mapping, compute its effects, check the plan's preconditions — and applying
 * continues past where planning stops. Running the identical sequence for both
 * is the point: a plan produced by different code than the apply would describe
 * something the apply does not do.
 */
export async function runApplicationSync(
  application: ApplicationId,
  client: UpstreamClient,
  request: ApplicationSyncRequest,
): Promise<ApplicationSyncOutcome> {
  if (application !== "prowlarr") {
    return {
      status: "error",
      dispatched: 0,
      error: failure(
        application,
        "unsupported_capability",
        "only Prowlarr synchronizes indexers into other applications",
      ),
    };
  }
  if (request.targets.length === 0) {
    return {
      status: "error",
      dispatched: 0,
      error: failure(application, "invalid_input", "no application mapping was named"),
    };
  }

  let observation: SyncObservation;
  try {
    observation = await readSyncObservation(application, client);
  } catch (error) {
    return { status: "error", dispatched: 0, error: toolErrorForThrown(error, application) };
  }

  const resolved: { mapping: ApplicationMapping; effects: readonly SyncEffect[] }[] = [];
  const items: SyncItemOutcome[] = [];
  const observations: ReadSetObservation[] = [];

  // Prowlarr's synchronization command is not addressed to a mapping: it runs
  // every one of them. So a call that starts one has to disclose every mapping,
  // not only the ones whose level it changes — otherwise applying a harmless
  // change to one mapping would carry out the deletions a *different* mapping's
  // full-sync level implies, and the caller would never have been shown them.
  const disclosed = request.startSync
    ? [
        ...request.targets,
        ...observation.mappings
          .map((mapping) => mapping.id)
          .filter((id) => !request.targets.includes(id)),
      ]
    : request.targets;

  for (const target of disclosed) {
    const named = request.targets.includes(target);
    const mapping = observation.mappings.find((candidate) => candidate.id === target);
    if (mapping === undefined) {
      return {
        status: "error",
        dispatched: 0,
        error: failure(
          application,
          "stale_reference",
          "this instance no longer reports that application mapping",
        ),
      };
    }
    // A level this server does not model blocks the whole call rather than one
    // mapping: every effect below is a claim about what the current level does,
    // and there is no honest claim to make about one that is unrecognized.
    if (mapping.level === undefined) {
      return {
        status: "error",
        dispatched: 0,
        error: failure(
          application,
          "unsupported_capability",
          "that application mapping reports a synchronization level this server does not model",
        ),
      };
    }

    observations.push(...syncObservations(mapping, observation.indexers, observation.tagLabels));
    // A mapping this call did not name keeps its own level, so what is disclosed
    // for it is what the started synchronization will do to it as it stands.
    const level = named ? request.syncLevel : mapping.level;
    const effects = planSyncEffects(mapping, observation.indexers, level);
    resolved.push({ mapping, effects });
    items.push({
      ref: mapping.ref,
      name: mapping.name,
      selection: describeSelection(mapping, observation.tagLabels),
      currentLevel: mapping.level,
      desiredLevel: level,
      effects,
      changed: named && mapping.level !== request.syncLevel,
      attempted: false,
      warnings: [
        ...(named && mapping.level === request.syncLevel
          ? ["this mapping is already at the requested synchronization level"]
          : []),
        ...(named
          ? []
          : [
              "this call does not change this mapping; it is listed because the synchronization it starts runs this mapping too",
            ]),
      ],
    });
  }

  if (request.planned !== undefined) {
    const comparison = compareReadSet(request.planned, fingerprintReadSet(observations));
    if (comparison.status === "changed") {
      const moved = [...comparison.changed, ...comparison.missing].sort().join(", ");
      return {
        status: "error",
        dispatched: 0,
        error: failure(
          application,
          "stale_plan",
          `the synchronization state this plan described has changed (${moved})`,
        ),
      };
    }
  }

  const effectWarnings = callWarnings(items);
  if (request.mode === "plan") {
    return {
      status: "planned",
      items,
      observations,
      warnings: [
        ...effectWarnings,
        request.startSync
          ? "a synchronization is started, which pushes every effect above immediately"
          : "no synchronization is started; Prowlarr applies these effects on its own schedule",
      ],
    };
  }

  const settled: SyncItemOutcome[] = [];
  let dispatched = 0;
  for (const [index, entry] of resolved.entries()) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }
    if (!item.changed) {
      settled.push(item);
      continue;
    }

    dispatched += 1;
    try {
      const route = `${routeFor("applications", application) ?? "applications"}/${String(entry.mapping.id)}`;
      await client.put(route, rewriteSyncLevel(entry.mapping, request.syncLevel));
      const verified = await confirmSyncLevel(application, client, entry.mapping.id, request);
      settled.push({ ...item, attempted: true, verified });
    } catch (error) {
      settled.push({ ...item, attempted: true, error: toolErrorForThrown(error, application) });
    }
  }

  // Started once, after the levels are written, because Prowlarr synchronizes
  // every mapping on one command and starting it per mapping would ask for the
  // same work several times over.
  //
  // And held back where a mapping this call changed is not confirmed at its new
  // level. The command runs every mapping at whatever level it is actually on,
  // so starting it after a failed write would carry out one set of effects
  // while this result described another — which is the one thing a disclosure
  // of remote deletions cannot afford to get wrong.
  const unconfirmed = settled.filter(
    (item) => item.changed && (item.error !== undefined || item.verified !== true),
  );
  let unresolved: ToolError | undefined;
  let sync: string;
  if (!request.startSync) {
    sync = "no synchronization was started; Prowlarr applies these effects on its own schedule";
  } else if (unconfirmed.length > 0) {
    sync = `no synchronization was started: ${String(unconfirmed.length)} mapping(s) this call changed are not confirmed at the requested level, and a synchronization would run them at whatever level they are actually on`;
  } else {
    dispatched += 1;
    try {
      await client.post("command", syncCommandPayload());
      sync = "a synchronization was started, which pushes every effect above immediately";
    } catch (error) {
      unresolved = toolErrorForThrown(error, application);
      sync =
        "a synchronization was sent and not acknowledged; whether it started is not established here";
    }
  }

  return {
    status: "applied",
    items: settled,
    observations,
    warnings: [...effectWarnings, sync],
    dispatched,
    ...(unresolved === undefined ? {} : { unresolved }),
  };
}

/**
 * Re-reads one mapping and reports whether the level actually landed.
 *
 * Verification is a separate read rather than a reading of the write's own
 * answer, because the question is what the instance now stores. An unreadable
 * answer is reported as unverified rather than as a failure: the write was
 * accepted, and saying otherwise would send a caller to undo something that
 * worked.
 */
async function confirmSyncLevel(
  application: ApplicationId,
  client: UpstreamClient,
  id: number,
  request: ApplicationSyncRequest,
): Promise<boolean> {
  try {
    const route = `${routeFor("applications", application) ?? "applications"}/${String(id)}`;
    const body = await client.get(route);
    const parsed = applicationSchema.safeParse(body);
    return parsed.success && readSyncLevel(parsed.data.syncLevel) === request.syncLevel;
  } catch {
    return false;
  }
}

/**
 * What the disclosed effects add up to, across every mapping this call named.
 *
 * The removal notice is the one that matters: a level that deletes indexers on
 * another application is the most consequential thing this surface does, and it
 * is disclosed by counting the effects rather than by testing the level again,
 * so a call that found nothing to remove does not warn about removals it is not
 * going to perform.
 *
 * What the synchronization itself did is deliberately not here. A plan predicts
 * it and an apply reports it, and those are different sentences: an apply that
 * held the command back must not repeat the plan's prediction that one ran.
 */
function callWarnings(items: readonly SyncItemOutcome[]): readonly string[] {
  const counted = (kind: SyncEffectKind): number =>
    items.reduce(
      (total, item) => total + item.effects.filter((effect) => effect.effect === kind).length,
      0,
    );
  const removals = counted("remove");
  const stale = counted("stale");

  return [
    ...(removals === 0
      ? []
      : [
          `this level deletes ${String(removals)} indexer(s) from the applications these mappings point at`,
        ]),
    ...(stale === 0
      ? []
      : [
          `${String(stale)} indexer mapping(s) are left as the remote already has them and are no longer maintained from here`,
        ]),
  ];
}
