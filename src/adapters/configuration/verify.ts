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
 * `indeterminate` is the important case and is never guessed past. Upstream not
 * answering, answering with something unreadable, or no longer reporting the
 * record at all leaves the outcome unknown — the write may well have succeeded
 * — and an unknown outcome outranks a comfortable verdict.
 *
 * A credential is verified by presence, which is all a credential can be
 * verified by: an instance that returns a mask has said that something is
 * stored, and this checks that it says so where a secret was set and stops
 * saying so where one was cleared. Presence is the weaker check, so it is used
 * nowhere else — every ordinary field, including a cleared one, is held to the
 * value this apply actually sent.
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
}

function fieldValues(record: Record<string, unknown>): ReadonlyMap<string, FieldEntry> {
  const values = new Map<string, FieldEntry>();
  const fields = record.fields;
  if (!Array.isArray(fields)) {
    return values;
  }
  for (const field of fields) {
    if (isUpstreamRecord(field) && typeof field.name === "string" && !values.has(field.name)) {
      values.set(field.name, {
        value: field.value,
        privacy: typeof field.privacy === "string" ? field.privacy : undefined,
      });
    }
  }
  return values;
}

/**
 * Whether two stored values are the same.
 *
 * A tag list is compared as a set: these applications are free to return the
 * identifiers in their own order, and reporting a reordered list as a
 * contradiction would turn a successful apply into a conflict for no reason.
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
  /** True when the record no longer carries the field this apply wrote. */
  readonly absent: boolean;
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
    absent: !(property in current),
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
    checks.push({
      path: `fields.${name}`,
      absent: !currentFields.has(name),
      agrees: matches(currentFields.get(name)?.value, sentFields.get(name)?.value, true),
    });
  };
  const checkSecret = (name: string, expected: "configured" | "unconfigured"): void => {
    const entry = currentFields.get(name);
    checks.push({
      path: `fields.${name}`,
      // A boolean read back where a credential was written is not a credential
      // at all — the shared classifier calls that a switch — so the field this
      // apply wrote is no longer there in the form it wrote it. That is a
      // changed shape rather than a verdict, and it settles as unknown.
      absent: entry === undefined || typeof entry.value === "boolean",
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
    // available. A cleared credential can be verified no other way — an
    // application may answer with an empty string, a null, or nothing at all,
    // and all three say the same thing — while an ordinary setting was sent an
    // explicit value and is held to it, so a clear that stored something else
    // cannot pass as a success.
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
 * record no longer carries is not a contradiction: the shape changed under the
 * apply, which is exactly the case nobody can settle from here.
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
  if (checks.length === 0 || checks.some((check) => check.absent)) {
    return indeterminate;
  }
  const disagreed = checks.filter((check) => !check.agrees).map((check) => check.path);
  return disagreed.length === 0
    ? { status: "succeeded" }
    : contradicted(request.application, disagreed);
}
