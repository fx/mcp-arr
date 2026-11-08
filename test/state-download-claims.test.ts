import { describe, expect, it } from "vitest";
import {
  createDownloadClaims,
  maxDownloadClaims,
  type PendingOutcome,
} from "../src/state/download-claims.js";
import { createWorkflowState } from "../src/state/workflow.js";

function started(commandId: string | undefined): PendingOutcome {
  return {
    action: "import",
    application: "sonarr",
    commandId,
    attemptedAt: 0,
    mediaId: 12,
    episodeIds: [1003],
  };
}

describe("download claims", () => {
  it("lets one caller hold a download and tells the next that it is held", () => {
    const claims = createDownloadClaims();

    expect(claims.tryClaim("sonarr\u0000id:a")).toBe("claimed");
    expect(claims.tryClaim("sonarr\u0000id:a")).toBe("held");
    expect(claims.tryClaim("sonarr\u0000id:b")).toBe("claimed");
    expect(claims.size).toBe(2);

    claims.release("sonarr\u0000id:a");
    expect(claims.tryClaim("sonarr\u0000id:a")).toBe("claimed");
  });

  it("keeps a claim for the import it started until that very import is released", () => {
    const claims = createDownloadClaims();
    const first = started("7001");
    claims.tryClaim("key");
    claims.markPending("key", first);

    expect(claims.pendingOf("key")).toBe(first);
    expect(claims.tryClaim("key")).toBe("held");

    // A refresh of a different import cannot release this one.
    claims.releasePending("key", started("7001"));
    expect(claims.pendingOf("key")).toBe(first);

    claims.releasePending("key", first);
    expect(claims.pendingOf("key")).toBeUndefined();
    expect(claims.tryClaim("key")).toBe("claimed");
  });

  it("holds an import whose answer was lost like any other", () => {
    const claims = createDownloadClaims();
    const uncertain = started(undefined);
    claims.tryClaim("key");
    claims.markPending("key", uncertain);

    expect(claims.pendingOf("key")?.commandId).toBeUndefined();
    expect(claims.tryClaim("key")).toBe("held");
    expect(claims.pending()).toEqual([["key", uncertain]]);
  });

  it("lists every claim waiting on an import, and no other", () => {
    const claims = createDownloadClaims();
    claims.tryClaim("acting");
    claims.tryClaim("importing");
    claims.markPending("importing", started("9"));

    expect(claims.pending()).toEqual([["importing", started("9")]]);
  });

  it("does not release a claim another call took after an import ended", () => {
    const claims = createDownloadClaims();
    const ended = started("1");
    claims.tryClaim("key");
    claims.markPending("key", ended);
    claims.releasePending("key", ended);
    expect(claims.tryClaim("key")).toBe("claimed");

    // A second refresh of the ended import arrives late.
    claims.releasePending("key", ended);
    expect(claims.tryClaim("key")).toBe("held");
  });

  it("claims an import's targets all or none, and releases them with the download", () => {
    const claims = createDownloadClaims();
    claims.tryClaim("one");
    claims.tryClaim("two");

    expect(claims.tryClaimTargets("one", ["episode:1", "episode:2"])).toBe(true);
    // Asking again for the targets it already holds is no conflict.
    expect(claims.tryClaimTargets("one", ["episode:2"])).toBe(true);
    expect(claims.tryClaimTargets("two", ["episode:2", "episode:3"])).toBe(false);
    expect(claims.targetHeldByOther("two", "episode:3")).toBe(false);
    expect(claims.targetHeldByOther("two", "episode:1")).toBe(true);
    expect(claims.targetHeldByOther("one", "episode:1")).toBe(false);

    claims.release("one");
    expect(claims.tryClaimTargets("two", ["episode:2", "episode:3"])).toBe(true);
  });

  it("keeps an importing download's targets until its import is released", () => {
    const claims = createDownloadClaims();
    const importing = started("5");
    claims.tryClaim("one");
    claims.tryClaimTargets("one", ["episode:1"]);
    claims.markPending("one", importing);

    expect(claims.targetHeldByOther("two", "episode:1")).toBe(true);
    claims.releasePending("one", importing);
    expect(claims.targetHeldByOther("two", "episode:1")).toBe(false);
  });

  it("refuses a new claim when full and never evicts one", () => {
    const claims = createDownloadClaims(2);
    claims.tryClaim("one");
    claims.tryClaim("two");

    expect(claims.tryClaim("three")).toBe("full");
    expect(claims.tryClaim("one")).toBe("held");
    expect(claims.size).toBe(2);

    claims.release("two");
    expect(claims.tryClaim("three")).toBe("claimed");
  });

  it("is bounded at a thousand downloads by default", () => {
    const claims = createDownloadClaims();
    for (let index = 0; index < maxDownloadClaims; index += 1) {
      expect(claims.tryClaim(`key ${index}`)).toBe("claimed");
    }
    expect(maxDownloadClaims).toBe(1_000);
    expect(claims.tryClaim("one more")).toBe("full");
  });

  it("is held by the workflow state, one map for the whole process", () => {
    const state = createWorkflowState();
    state.downloadClaims.tryClaim("key");

    expect(state.downloadClaims.tryClaim("key")).toBe("held");
    expect(createWorkflowState().downloadClaims.tryClaim("key")).toBe("claimed");
  });
});
