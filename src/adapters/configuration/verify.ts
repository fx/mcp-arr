import type { ApplicationId } from "../../applications.js";
import type { UpstreamBody, UpstreamClient } from "../../http/client.js";
import type { ApplyReconciliation } from "../../state/apply-records.js";
import { createToolError } from "../../tools/errors.js";
import { classifyProviderField, describeSecret } from "./fields.js";
import { isUpstreamRecord } from "./parse.js";
import type { CompiledPatch } from "./patches.js";
import { enableSwitches } from "./write.js";

/**
 * Apply verification.
 *
 * A full-resource write is accepted or refused by the instance, and neither
 * answer says what the instance actually stored: it may normalize a value,
 * clamp it, ignore a field its version does not model, or answer the write with
 * no body at all. So an apply is confirmed by reading the record back and
 * checking the fields this apply set, and nothing else.
 *
 * The vocabulary is {@link ApplyReconciliation} rather than one invented here,
 * because this is the same question the receipt store asks when an answer was
 * lost: did the mutation take effect? Sharing the type is what lets this double
 * as the reader an outcome-unknown record is later reconciled with.
 *
 * `indeterminate` is the important case and is never guessed past. It covers
 * the instance not answering, answering with something unreadable, or no longer
 * reporting the record — and, field by field, a field the record no longer
 * carries, one that came back in a shape this apply did not write, and one the
 * record now carries twice. The write may well have succeeded in every one of
 * those cases, and an unknown outcome outranks a comfortable verdict.
 *
 * Two questions are asked of every field, in this order, and keeping them apart
 * is what the checks below are built around. *Is the field there to be read?* —
 * a name that is missing, duplicated, or answered in another shape settles as
 * unknown, whatever it holds. Only then: *does what it holds match what was
 * sent?*
 *
 * The second question is where a credential differs. It is answered by presence
 * — an instance that returns a mask has said that something is stored, and
 * nothing more — so a set credential is checked for being configured and a
 * cleared one for not being, and an entry holding a null, a blank string, or no
 * value at all is a confirmed clear rather than a missing field. Presence is the
 * weaker answer, so it is used nowhere else: every ordinary field, including a
 * cleared one, is held to the value this apply actually sent.
 */

export interface VerificationRequest {
  readonly application: ApplicationId;
  /** The single-resource route this apply wrote to. */
  readonly route: string;
  readonly patch: CompiledPatch;
  /** The complete resource this apply sent. */
  readonly sent: UpstreamBody;
  /**
   * The body the write itself answered with, where it answered with one. These
   * APIs return the stored resource from a successful update, so this usually
   * makes the verification free; when it is absent or unreadable the record is
   * read back instead.
   */
  readonly answered?: unknown;
}

const indeterminate: ApplyReconciliation = { status: "indeterminate" };

function contradicted(application: ApplicationId, paths: readonly string[]): ApplyReconciliation {
  return {
    status: "failed",
    error: createToolError({
      // Not `upstream_rejection`: the instance accepted the request. It simply
      // holds something other than what was sent, which is a conflict a caller
      // resolves by re-reading and deciding again.
      code: "conflict",
      message: `${application}: this application stored something other than the requested ${paths.join(", ")}`,
      application,
    }),
  };
}

interface FieldEntry {
  readonly value: unknown;
  readonly privacy: string | undefined;
  /**
   * The record carries this name more than once.
   *
   * Kept rather than resolved. Two entries under one name may hold different
   * values, so the record does not say what the field holds — and a reader that
   * silently took the first would answer a question the payload has not
   * answered. Everything that reads a field entry here treats this as "cannot
   * be established", which is what keeps an ambiguous record from producing a
   * confident verdict.
   */
  readonly duplicated: boolean;
}

function fieldValues(record: Record<string, unknown>): ReadonlyMap<string, FieldEntry> {
  const values = new Map<string, FieldEntry>();
  const fields = record.fields;
  if (!Array.isArray(fields)) {
    return values;
  }
  for (const field of fields) {
    if (!isUpstreamRecord(field) || typeof field.name !== "string") {
      continue;
    }
    const seen = values.get(field.name);
    // The first entry's value is kept only so the map has one; a duplicated
    // name settles as unknown before that value is ever compared.
    values.set(field.name, {
      value: seen?.value ?? field.value,
      privacy: seen?.privacy ?? (typeof field.privacy === "string" ? field.privacy : undefined),
      duplicated: seen !== undefined,
    });
  }
  return values;
}

/**
 * Whether two stored values are the same.
 *
 * A tag list is compared as a set: a record's tags are a membership upstream,
 * these applications are free to return the identifiers in their own order, and
 * reporting a reordered list as a contradiction would turn a successful apply
 * into a conflict for no reason. Every other list is compared in order, because
 * a provider's own list fields were sent in the order the caller asked for and
 * nothing says the instance may reorder them.
 */
function matches(left: unknown, right: unknown, ordered: boolean): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    if (ordered) {
      return left.every((item, index) => item === right[index]);
    }
    const remaining = [...right];
    return left.every((item) => {
      const index = remaining.indexOf(item);
      if (index < 0) {
        return false;
      }
      remaining.splice(index, 1);
      return true;
    });
  }
  return left === right;
}

interface Check {
  readonly path: string;
  /**
   * The record cannot answer for this field: it is gone, it came back in a
   * shape this apply did not write, or it appears more than once. None of those
   * is a verdict, so any one of them settles the whole verification as unknown.
   */
  readonly unsettled: boolean;
  readonly agrees: boolean;
}

function checkProperty(
  current: Record<string, unknown>,
  sent: Record<string, unknown>,
  property: string,
  ordered = true,
): Check {
  return {
    path: property,
    unsettled: !(property in current),
    agrees: matches(current[property], sent[property], ordered),
  };
}

function checksFor(
  patch: CompiledPatch,
  current: Record<string, unknown>,
  sent: Record<string, unknown>,
): readonly Check[] {
  const currentFields = fieldValues(current);
  const sentFields = fieldValues(sent);
  const checks: Check[] = [];

  const checkField = (name: string): void => {
    const entry = currentFields.get(name);
    checks.push({
      path: `fields.${name}`,
      unsettled: entry === undefined || entry.duplicated,
      agrees: matches(entry?.value, sentFields.get(name)?.value, true),
    });
  };
  const checkSecret = (name: string, expected: "configured" | "unconfigured"): void => {
    const entry = currentFields.get(name);
    checks.push({
      path: `fields.${name}`,
      // Whether the field is there to be read, which is a different question
      // from what it holds. No entry at all means the record dropped the field
      // this apply wrote, rather than that the field is empty; two entries mean
      // it does not say which; and a boolean is not a credential at all — the
      // shared classifier calls that a switch. None of the three is a verdict.
      unsettled: entry === undefined || entry.duplicated || typeof entry.value === "boolean",
      // And only then, what it holds. An entry carrying a null, a blank string,
      // or no value at all is unconfigured, so a clear is confirmed by any of
      // the three spellings an application might answer with.
      agrees: describeSecret(name, entry?.value).state === expected,
    });
  };
  /**
   * Whether the field this apply wrote is one the record treats as a
   * credential, judged from the resource that was sent — which is the resource
   * the writer itself classified from, so the two cannot disagree about which
   * fields were written as secrets.
   */
  const isCredential = (name: string): boolean =>
    classifyProviderField({ name, privacy: sentFields.get(name)?.privacy }) === "secret";

  for (const assignment of patch.assignments) {
    switch (assignment.target) {
      case "property":
      case "reference":
        checks.push(checkProperty(current, sent, assignment.property));
        break;
      case "enabled":
        // The writer's own predicate, not a weaker one. It moves a switch only
        // where the record carried a boolean, so a legacy property of some
        // other type was never written and is not evidence about this apply.
        for (const property of enableSwitches) {
          if (typeof sent[property] === "boolean") {
            checks.push(checkProperty(current, sent, property));
          }
        }
        break;
      case "tags":
        checks.push(checkProperty(current, sent, "tags", false));
        break;
      case "field":
        checkField(assignment.name);
        break;
      case "secret":
        checkSecret(assignment.name, "configured");
        break;
    }
  }

  for (const removal of patch.removals) {
    if (removal.target === "tags") {
      checks.push(checkProperty(current, sent, "tags", false));
      continue;
    }
    // Presence is the weaker check and is used only where it is the only one
    // available. A cleared credential can be verified no other way, since an
    // entry holding an empty string, a null, or no value at all all say the one
    // thing a credential can say. An ordinary setting was sent an explicit
    // value and is held to it, so a clear that stored something else cannot
    // pass as a success.
    if (isCredential(removal.name)) {
      checkSecret(removal.name, "unconfigured");
    } else {
      checkField(removal.name);
    }
  }

  return checks;
}

/**
 * Confirms that upstream state reflects what this apply sent.
 *
 * The record is taken from the write's own answer where there is one, and read
 * back otherwise, so the ordinary case costs no extra request. A field the
 * record no longer carries — or now carries twice — is not a contradiction:
 * the shape changed under the apply, which is exactly the case nobody can
 * settle from here.
 *
 * A patch that produced no check at all is a floor rather than a case. Nothing
 * that reaches here can produce one — a desired state naming nothing is refused
 * at compilation, and an enable with no switch to move is refused by the writer
 * — so if one ever did, it would have established nothing.
 */
export async function verifyConfigurationApply(
  client: UpstreamClient,
  request: VerificationRequest,
): Promise<ApplyReconciliation> {
  let current = request.answered;
  if (!isUpstreamRecord(current)) {
    try {
      current = await client.get(request.route);
    } catch {
      return indeterminate;
    }
  }
  if (!isUpstreamRecord(current)) {
    return indeterminate;
  }
  if (!isUpstreamRecord(request.sent)) {
    return indeterminate;
  }

  const checks = checksFor(request.patch, current, request.sent);
  if (checks.length === 0 || checks.some((check) => check.unsettled)) {
    return indeterminate;
  }
  const disagreed = checks.filter((check) => !check.agrees).map((check) => check.path);
  return disagreed.length === 0
    ? { status: "succeeded" }
    : contradicted(request.application, disagreed);
}
