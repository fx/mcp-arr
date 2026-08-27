import type { ApplicationId } from "../../applications.js";
import type { UpstreamClient } from "../../http/client.js";
import { UpstreamError } from "../../http/errors.js";
import { createToolError, type ToolError, toolErrorForThrown } from "../../tools/errors.js";
import { type Continuation, maxPageSize } from "../../tools/schemas/common.js";
import {
  type AdapterPage,
  decodePageCursor,
  encodePageCursor,
  type PageWindow,
  projectPage,
  queryDigest,
} from "../library/paging.js";
import {
  type ConfigurationDomain,
  familyOf,
  isProviderDomain,
  providerSchemaRouteFor,
  routeFor,
} from "./domains.js";
import type {
  ConfigurationRecord,
  ConfigurationView,
  ProfileRecord,
  ProviderRecord,
  ProviderSchema,
  ProviderTemplate,
  ResourceRecord,
} from "./model.js";
import { isUpstreamRecord, parseCollection } from "./parse.js";
import {
  ConfigurationResourceSet,
  captureUpstreamResource,
  type UpstreamResource,
  type UpstreamValue,
} from "./resources.js";
import {
  type ConfigurationDetail,
  type SerializationContext,
  serializeProfile,
  serializeProvider,
  serializeProviderTemplate,
  serializeResource,
} from "./serialize.js";

/**
 * The configuration observation service.
 *
 * It is the single entry point for reading upstream configuration, and it
 * produces two things from one read that are deliberately not the same object:
 * an allowlisted {@link ConfigurationView} for the calling agent, and a
 * {@link ConfigurationResourceSet} holding the untouched upstream payloads that
 * a later full-resource write has to send back. Nothing merges them, and only
 * the view is meant to reach a tool result.
 *
 * Like the library service, it decides support before sending anything, owns
 * the continuation cursor so no reader has to, and normalizes every failure
 * into the shared {@link ToolError} vocabulary.
 */

export interface ConfigurationPaging {
  readonly pageSize: number;
  /** A continuation minted by a previous page of this same observation. */
  readonly cursor?: string | undefined;
}

export interface ConfigurationObservationRequest {
  readonly domain: ConfigurationDomain;
  readonly detail: ConfigurationDetail;
  readonly paging: ConfigurationPaging;
  /**
   * Also read the instance's provider templates.
   *
   * Provider field lists are version specific, so the templates come from the
   * instance rather than from a table compiled into this server. It is opt-in
   * because it costs a second upstream request, and it is meaningless outside a
   * provider domain — a profile has a fixed shape and no schema route.
   */
  readonly includeSchema?: boolean | undefined;
}

export type ConfigurationObservationOutcome =
  | {
      readonly status: "ok";
      readonly data: ConfigurationView;
      /**
       * The untouched upstream payloads behind this page. Internal: it holds
       * the secret values the view exists to keep out, so it belongs to
       * reconciliation and never to a tool result.
       */
      readonly resources: ConfigurationResourceSet;
      readonly continuation: Continuation;
      readonly warnings: readonly string[];
    }
  | { readonly status: "error"; readonly error: ToolError };

function unsupported(application: ApplicationId, domain: ConfigurationDomain): ToolError {
  return createToolError({
    code: "unsupported_capability",
    message: `${application}: the ${domain} configuration domain is not available on this application`,
    application,
  });
}

function invalid(application: ApplicationId, message: string): ToolError {
  return createToolError({
    code: "invalid_input",
    message: `${application}: ${message}`,
    application,
  });
}

/** The ordered parts this observation's continuation cursor is digested from. */
function digestParts(
  application: ApplicationId,
  request: ConfigurationObservationRequest,
): readonly (string | number | boolean | undefined)[] {
  return [
    application,
    request.domain,
    request.detail,
    request.paging.pageSize,
    request.includeSchema === true,
  ];
}

interface MappedRecord {
  readonly record: ConfigurationRecord;
  readonly resource: UpstreamResource;
}

/**
 * Maps one upstream element into both representations at once.
 *
 * The lossless capture happens first and from the element itself, so the safe
 * record can never be what a later write is rebuilt from.
 */
function mapRecord(context: SerializationContext, value: unknown): MappedRecord {
  const resource = captureUpstreamResource(
    context.application,
    context.domain,
    value as UpstreamValue,
  );
  if (!isUpstreamRecord(value)) {
    // `parseCollection` already established this is an array; an element that
    // is not an object is a payload this server cannot read, and refusing it
    // names only the route.
    throw new UpstreamError("unexpected-response", {
      application: context.application,
      operation: context.route,
    });
  }

  switch (familyOf(context.domain)) {
    case "provider":
      return { record: serializeProvider(context, value), resource };
    case "profile":
      return { record: serializeProfile(context, value), resource };
    case "resource":
      return { record: serializeResource(context, value), resource };
  }
}

function viewOf(
  domain: ConfigurationDomain,
  records: readonly ConfigurationRecord[],
  schema: ProviderSchema | undefined,
): ConfigurationView {
  switch (familyOf(domain)) {
    case "provider":
      return {
        family: "provider",
        domain,
        records: records as readonly ProviderRecord[],
        ...(schema === undefined ? {} : { schema }),
      };
    case "profile":
      return { family: "profile", domain, records: records as readonly ProfileRecord[] };
    case "resource":
      return { family: "resource", domain, records: records as readonly ResourceRecord[] };
  }
}

/**
 * Reads one provider domain's templates from the instance.
 *
 * A template whose payload names no implementation is dropped rather than
 * reported under an invented name: it is the implementation a later create has
 * to name, so a template without one describes nothing a caller could use.
 */
async function readProviderTemplates(
  client: UpstreamClient,
  context: SerializationContext,
): Promise<readonly ProviderTemplate[]> {
  const body = await client.get(context.route);
  return parseCollection(body, context.application, context.route).flatMap((value) => {
    if (!isUpstreamRecord(value)) {
      throw new UpstreamError("unexpected-response", {
        application: context.application,
        operation: context.route,
      });
    }
    const template = serializeProviderTemplate(context, value);
    return template === undefined ? [] : [template];
  });
}

/**
 * Answers one bounded configuration observation.
 *
 * A domain the selected application does not model — Prowlarr asked for root
 * folders, Sonarr asked for Prowlarr's application list — is refused as an
 * unsupported capability before a request is sent, rather than being emulated
 * or answered with an empty page.
 */
export async function runConfigurationObservation(
  application: ApplicationId,
  client: UpstreamClient,
  request: ConfigurationObservationRequest,
): Promise<ConfigurationObservationOutcome> {
  const route = routeFor(request.domain, application);
  if (route === undefined) {
    return { status: "error", error: unsupported(application, request.domain) };
  }

  const pageSize = request.paging.pageSize;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    return {
      status: "error",
      error: invalid(application, `page size must be between 1 and ${maxPageSize}`),
    };
  }

  const digest = queryDigest(digestParts(application, request));
  let offset = 0;
  if (request.paging.cursor !== undefined) {
    const decoded = decodePageCursor(request.paging.cursor, digest);
    if (!decoded.ok) {
      return {
        status: "error",
        error: invalid(
          application,
          decoded.reason === "mismatched"
            ? "that continuation belongs to a different observation; repeat the first page with these arguments"
            : "that continuation was not issued by this server",
        ),
      };
    }
    offset = decoded.offset;
  }

  const window: PageWindow = { offset, pageSize };
  const context: SerializationContext = {
    application,
    domain: request.domain,
    route,
    detail: request.detail,
  };

  let page: AdapterPage<MappedRecord>;
  let schema: ProviderSchema | undefined;
  try {
    const body = await client.get(route);
    page = projectPage<unknown, MappedRecord>({
      source: parseCollection(body, application, route),
      window,
      map: (value) => mapRecord(context, value),
    });

    if (request.includeSchema === true && isProviderDomain(request.domain)) {
      const schemaRoute = providerSchemaRouteFor(request.domain, application);
      if (schemaRoute !== undefined) {
        schema = {
          application,
          domain: request.domain,
          templates: await readProviderTemplates(client, { ...context, route: schemaRoute }),
        };
      }
    }
  } catch (error) {
    return { status: "error", error: toolErrorForThrown(error, application) };
  }

  const continuation: Continuation = {
    pageSize,
    returned: page.items.length,
    hasMore: page.hasMore,
    ...(page.hasMore ? { cursor: encodePageCursor(digest, offset + pageSize) } : {}),
  };

  return {
    status: "ok",
    data: viewOf(
      request.domain,
      page.items.map((item) => item.record),
      schema,
    ),
    resources: new ConfigurationResourceSet(
      application,
      request.domain,
      page.items.map((item) => item.resource),
    ),
    continuation,
    warnings: [...(page.warnings ?? [])],
  };
}
