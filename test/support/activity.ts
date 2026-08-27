import type {
  BlocklistRecord,
  CommandActivity,
  DiskCondition,
  HealthCheck,
  HistoryRecord,
  QueueItem,
  QueueSummary,
} from "../../src/adapters/activity/model.js";
import type { ActivityPaging } from "../../src/adapters/activity/requests.js";
import type {
  ActivityQueryOutcome,
  ActivityViewData,
} from "../../src/adapters/activity/service.js";
import { type FixtureApplication, fixturePathFor, loadFixture } from "./fixtures.js";
import { jsonResponse, type UpstreamCall } from "./library.js";
import { fixtureRoot } from "./tool-context.js";

/**
 * The recorded response body for one application's activity route.
 *
 * The library helper of the same name narrows to the two applications that own
 * a library; activity is read from all three, so this one accepts any recorded
 * application.
 */
export async function activityFixture<TBody = unknown>(
  application: FixtureApplication,
  route: string,
): Promise<TBody> {
  const fixture = await loadFixture<TBody>(fixtureRoot, fixturePathFor(application, route));
  return fixture.body;
}

export function paging(pageSize = 25, cursor?: string): ActivityPaging {
  return { pageSize, cursor };
}

/**
 * A responder that applies the window the adapter asked for.
 *
 * It is deliberately not a stub that returns everything: the point of several
 * of these tests is that the adapter asks the instance for one page, so the
 * fake instance behaves like one that pages server-side and a fetch-all-then-
 * slice adapter would fail them.
 */
export function servePagedRecords(
  records: readonly unknown[],
  totalRecords: number | undefined = records.length,
): (call: UpstreamCall) => Response {
  return (call) => {
    const page = Number(call.url.searchParams.get("page") ?? "1");
    const pageSize = Number(call.url.searchParams.get("pageSize") ?? String(records.length));
    const offset = (page - 1) * pageSize;
    return jsonResponse({
      page,
      pageSize,
      ...(totalRecords === undefined ? {} : { totalRecords }),
      records: records.slice(offset, offset + pageSize),
    });
  };
}

export function expectOk(outcome: ActivityQueryOutcome) {
  if (outcome.status !== "ok") {
    throw new Error(`Expected an ok outcome, got ${outcome.error.code}: ${outcome.error.message}`);
  }
  return outcome;
}

export function expectError(outcome: ActivityQueryOutcome) {
  if (outcome.status !== "error") {
    throw new Error("Expected an error outcome");
  }
  return outcome.error;
}

/**
 * Narrows one view's payload to the family it produces.
 *
 * The view union is discriminated, so each accessor asserts the view rather
 * than casting: asking a health page for queue items fails loudly instead of
 * silently typing the wrong thing.
 */
export function queueItems(data: ActivityViewData): readonly QueueItem[] {
  if (data.view !== "queue") {
    throw new Error(`Expected the queue view, got ${data.view}`);
  }
  return data.items;
}

export function queueSummary(data: ActivityViewData): QueueSummary {
  if (data.view !== "queue_status") {
    throw new Error(`Expected the queue_status view, got ${data.view}`);
  }
  return data.summary;
}

export function queueDetail(data: ActivityViewData): QueueItem {
  if (data.view !== "queue_details") {
    throw new Error(`Expected the queue_details view, got ${data.view}`);
  }
  return data.item;
}

export function historyRecords(data: ActivityViewData): readonly HistoryRecord[] {
  if (data.view !== "history") {
    throw new Error(`Expected the history view, got ${data.view}`);
  }
  return data.items;
}

export function blocklistRecords(data: ActivityViewData): readonly BlocklistRecord[] {
  if (data.view !== "blocklist") {
    throw new Error(`Expected the blocklist view, got ${data.view}`);
  }
  return data.items;
}

export function healthChecks(data: ActivityViewData): readonly HealthCheck[] {
  if (data.view !== "health") {
    throw new Error(`Expected the health view, got ${data.view}`);
  }
  return data.items;
}

export function commandActivity(data: ActivityViewData): readonly CommandActivity[] {
  if (data.view !== "commands") {
    throw new Error(`Expected the commands view, got ${data.view}`);
  }
  return data.items;
}

export function diskConditions(data: ActivityViewData): readonly DiskCondition[] {
  if (data.view !== "disk_space") {
    throw new Error(`Expected the disk_space view, got ${data.view}`);
  }
  return data.items;
}
