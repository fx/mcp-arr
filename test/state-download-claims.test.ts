import { describe, expect, it } from "vitest";
import { createDownloadClaims, maxDownloadClaims } from "../src/state/download-claims.js";
import { createWorkflowState } from "../src/state/workflow.js";

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

  it("keeps a claim for the import it started until that import is released", () => {
    const claims = createDownloadClaims();
    claims.tryClaim("key");
    claims.markImporting("key", { application: "sonarr", commandId: "7001" });

    expect(claims.importOf("key")).toEqual({ application: "sonarr", commandId: "7001" });
    expect(claims.tryClaim("key")).toBe("held");

    // A refresh of a different command cannot release this one.
    claims.releaseImport("key", "7002");
    expect(claims.importOf("key")?.commandId).toBe("7001");

    claims.releaseImport("key", "7001");
    expect(claims.importOf("key")).toBeUndefined();
    expect(claims.tryClaim("key")).toBe("claimed");
  });

  it("lists every claim waiting on an import, and no other", () => {
    const claims = createDownloadClaims();
    claims.tryClaim("acting");
    claims.tryClaim("importing");
    claims.markImporting("importing", { application: "radarr", commandId: "9" });

    expect(claims.imports()).toEqual([["importing", { application: "radarr", commandId: "9" }]]);
  });

  it("does not release a claim another call took after an import ended", () => {
    const claims = createDownloadClaims();
    claims.tryClaim("key");
    claims.markImporting("key", { application: "radarr", commandId: "1" });
    claims.releaseImport("key", "1");
    expect(claims.tryClaim("key")).toBe("claimed");

    // A second refresh of the ended import arrives late.
    claims.releaseImport("key", "1");
    expect(claims.tryClaim("key")).toBe("held");
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
