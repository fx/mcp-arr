import { beforeAll, describe, expect, it } from "vitest";
import type { ReleaseSearchItem } from "../src/adapters/acquisition/model.js";
import type { ReleaseSearchRequest } from "../src/adapters/acquisition/requests.js";
import { runReleaseSearch } from "../src/adapters/acquisition/service.js";
import type { ApplicationId } from "../src/applications.js";
import {
  expectError,
  expectOk,
  jsonResponse,
  releasePaging,
  searchHarness,
  titlesOf,
  type UpstreamCall,
} from "./support/acquisition.js";
import { fixtureBody } from "./support/library.js";

/**
 * The Sonarr and Radarr interactive-search adapters.
 *
 * Both applications answer the same route with the same resource, so they are
 * exercised together: what differs is the search target each one accepts and
 * the namespaced fields each one adds.
 */

type ReleaseRecord = Record<string, unknown>;

const releases: Record<"sonarr" | "radarr", ReleaseRecord[]> = { sonarr: [], radarr: [] };

beforeAll(async () => {
  releases.sonarr = await fixtureBody<ReleaseRecord[]>("sonarr", "release");
  releases.radarr = await fixtureBody<ReleaseRecord[]>("radarr", "release");
});

interface Run {
  readonly items: readonly ReleaseSearchItem[];
  readonly warnings: readonly string[];
  readonly calls: readonly UpstreamCall[];
}

async function run(
  application: ApplicationId,
  request: ReleaseSearchRequest,
  body: unknown,
): Promise<Run> {
  const harness = searchHarness(application, () => jsonResponse(body));
  const ok = expectOk(await runReleaseSearch(application, harness.client, request));
  return { items: ok.data.items, warnings: ok.warnings, calls: harness.calls };
}

const episodeSearch: ReleaseSearchRequest = {
  target: "sonarr_episode",
  detail: "summary",
  episodeId: 4321,
  paging: releasePaging(),
};

const movieSearch: ReleaseSearchRequest = {
  target: "radarr_movie",
  detail: "summary",
  movieId: 87,
  paging: releasePaging(),
};

describe("sonarr interactive search", () => {
  it("asks the release route for one episode and normalizes what came back", async () => {
    const { items, calls } = await run("sonarr", episodeSearch, releases.sonarr);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/api/v3/release");
    expect(calls[0]?.url.searchParams.get("episodeId")).toBe("4321");
    expect(calls[0]?.init.method).toBe("GET");

    const [approved] = items;
    expect(approved?.release).toMatchObject({
      application: "sonarr",
      title: "Example Series S01E01 1080p WEB-DL x264-EXAMPLEGRP",
      protocol: "torrent",
      indexer: { id: 1, name: "Example Indexer A" },
      sizeBytes: 1503238553,
      publishedAt: "2026-08-20T11:15:00Z",
      ageMinutes: 4470,
      seeders: 42,
      leechers: 3,
      releaseGroup: "EXAMPLEGRP",
      languages: ["English"],
      quality: { name: "WEBDL-1080p", source: "web", resolution: 1080, proper: false },
      decision: { approved: true, rejections: [] },
      sonarr: { seriesTitle: "Example Series", seasonNumber: 1, episodeNumbers: [1] },
    });
    // A summary result carries no custom-format or indexer-flag list.
    expect(approved?.release.detail).toBeUndefined();
  });

  it("normalizes both rejection serializations and keeps the permanence apart", async () => {
    const { items } = await run("sonarr", episodeSearch, releases.sonarr);

    expect(items[1]?.release.decision).toEqual({
      approved: false,
      rejections: [
        { reason: "Quality HDTV-720p is not wanted in profile", type: "permanent" },
        { reason: "Indexer request limit reached", type: "temporary" },
      ],
    });
    // A bare reason string says nothing about permanence, so nothing is claimed.
    expect(items[2]?.release.decision).toEqual({
      approved: false,
      rejections: [
        { reason: "Full season release is not wanted for a single episode", type: "unknown" },
      ],
    });
    expect(items[2]?.release).toMatchObject({ sonarr: { fullSeason: true } });
    expect(items[1]?.release.quality).toMatchObject({ proper: true, repack: true });
  });

  it("searches a whole season by series and season number", async () => {
    const { calls } = await run(
      "sonarr",
      {
        target: "sonarr_season",
        detail: "summary",
        seriesId: 12,
        seasonNumber: 3,
        paging: releasePaging(),
      },
      releases.sonarr,
    );

    expect(calls[0]?.url.pathname).toBe("/api/v3/release");
    expect(calls[0]?.url.searchParams.get("seriesId")).toBe("12");
    expect(calls[0]?.url.searchParams.get("seasonNumber")).toBe("3");
    expect(calls[0]?.url.searchParams.get("episodeId")).toBeNull();
  });

  it("adds custom formats and indexer flags only at full detail", async () => {
    const { items } = await run("sonarr", { ...episodeSearch, detail: "full" }, releases.sonarr);

    expect(items[0]?.release.detail).toEqual({
      customFormats: ["Example Custom Format"],
      customFormatScore: 25,
    });
    // A score of zero is a real answer, so the record stays; the lists the
    // instance returned empty are absent rather than reported as empty.
    expect(items[1]?.release.detail).toMatchObject({ customFormatScore: 0 });
    expect(items[1]?.release.detail?.customFormats).toBeUndefined();
    // Every row of the recorded body carries the bitmask this version sends,
    // which names nothing.
    for (const item of items) {
      expect(item.release.detail?.indexerFlags).toBeUndefined();
    }
  });

  it("names the indexer flags of an instance that reports them as a list", async () => {
    const [record] = releases.sonarr;
    const { items } = await run("sonarr", { ...episodeSearch, detail: "full" }, [
      { ...record, indexerFlags: ["G_Freeleech", 4, null, "G_Halfleech"] },
    ]);

    expect(items[0]?.release.detail?.indexerFlags).toEqual(["G_Freeleech", "G_Halfleech"]);
  });
});

/**
 * The advisory field an instance may describe in a shape this server never
 * modelled. Nothing a caller receives depends on it, so an unmodelled shape
 * costs the flags and nothing else — while a field the answer does depend on is
 * still required, which is what keeps this tolerance from spreading.
 */
describe("an unmodelled indexer-flag shape", () => {
  const unnameable = [0, 12, "G_Freeleech", { bits: 12 }, true];

  it.each(unnameable)("returns the release with no flags when it is %o", async (flags) => {
    const [record] = releases.sonarr;
    const { items } = await run("sonarr", { ...episodeSearch, detail: "full" }, [
      { ...record, indexerFlags: flags },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.release.detail?.indexerFlags).toBeUndefined();
  });

  it("leaves every other mapped field of the release intact", async () => {
    const [record] = releases.sonarr;
    const request = { ...episodeSearch, detail: "full" } as const;
    const { items: tolerated } = await run("sonarr", request, [{ ...record, indexerFlags: 12 }]);
    const { items: listed } = await run("sonarr", request, [{ ...record, indexerFlags: [] }]);

    expect(tolerated[0]?.release).toEqual(listed[0]?.release);
    expect(tolerated[0]?.identity).toEqual(listed[0]?.identity);
    expect(tolerated[0]?.release).toMatchObject({
      title: "Example Series S01E01 1080p WEB-DL x264-EXAMPLEGRP",
      indexer: { id: 1, name: "Example Indexer A" },
      quality: { name: "WEBDL-1080p", source: "web", resolution: 1080 },
      decision: { approved: true, rejections: [] },
      sonarr: { seriesTitle: "Example Series", seasonNumber: 1 },
    });
  });

  it("does not extend to a release with no usable identity or title", async () => {
    const [record] = releases.sonarr;
    const harness = searchHarness("sonarr", () =>
      jsonResponse([{ ...record, guid: "", title: "" }]),
    );

    const error = expectError(await runReleaseSearch("sonarr", harness.client, episodeSearch));

    expect(error.code).toBe("unexpected_response");
  });
});

describe("radarr interactive search", () => {
  it("asks the release route for one movie and keeps every matched title", async () => {
    const { items, calls } = await run("radarr", movieSearch, releases.radarr);

    expect(calls[0]?.url.pathname).toBe("/api/v3/release");
    expect(calls[0]?.url.searchParams.get("movieId")).toBe("87");

    expect(items[0]?.release).toMatchObject({
      application: "radarr",
      protocol: "torrent",
      radarr: {
        movieTitles: ["Example Movie", "Example Movie Alternate Title"],
        year: 2021,
        edition: "Director's Cut",
      },
    });
    // An instance that reports the single-title form is normalized to the list.
    expect(items[1]?.release).toMatchObject({
      radarr: { movieTitles: ["Example Movie"], edition: undefined },
    });
    expect(items[2]?.release.quality).toMatchObject({ proper: true, repack: false });
    expect(items[2]?.release.languages).toEqual(["English", "French"]);
  });

  it("normalizes an instance that reports age in days only", async () => {
    const [record] = releases.radarr;
    const { items } = await run("radarr", movieSearch, [
      { ...record, ageMinutes: null, ageHours: null, age: 12 },
    ]);

    expect(items[0]?.release.ageMinutes).toBe(12 * 24 * 60);
  });

  it("keeps a release whose protocol it does not recognize, saying so", async () => {
    const [record] = releases.radarr;
    const { items } = await run("radarr", movieSearch, [{ ...record, protocol: "carrierPigeon" }]);

    expect(items[0]?.release.protocol).toBe("unknown");
  });
});

describe("protected release data", () => {
  const canary = "CANARY-8f3a2b-DO-NOT-LEAK";
  const trackerHost = "tracker.example.invalid";

  /**
   * The recorded fixtures cannot carry a protected URL — the fixture contract
   * refuses to store one — so the canary is planted here instead, in exactly
   * the fields a real instance returns it in.
   *
   * Every label on a release is one of them, which is why the canary goes into
   * all of them rather than into the field a defect was demonstrated on. A
   * custom format is named by the operator, an indexer flag and a category by
   * the indexer, and the quality, language, release group, and indexer name are
   * names an application publishes and an operator may rewrite — so each can
   * carry a link, a credential, or a canonical path, and none of them may carry
   * one out. Two of these lists reach a caller only at full detail, so both
   * detail levels are swept below and a field mapped at just one of them cannot
   * escape the check.
   *
   * The title is deliberately left alone: it is the release's identity, it is
   * passed through as every adapter here passes an application's own title, and
   * poisoning it would assert a rule this server does not hold.
   */
  function poisoned(records: readonly ReleaseRecord[]): ReleaseRecord[] {
    return records.map((record) => ({
      ...record,
      downloadUrl: `https://${trackerHost}/download?apikey=${canary}`,
      magnetUrl: `magnet:?xt=urn:btih:${canary}`,
      infoUrl: `https://${trackerHost}/details?id=${canary}`,
      commentUrl: `https://${trackerHost}/comments?id=${canary}`,
      indexer: `Example Indexer, see https://${trackerHost}/about?id=${canary}`,
      releaseGroup: `EXAMPLEGRP https://${trackerHost}/group?id=${canary}`,
      quality: {
        quality: {
          name: `WEBDL-1080p, see https://${trackerHost}/quality?id=${canary}`,
          source: `/media/private/${canary}/web`,
          resolution: 1080,
        },
        revision: { version: 1, real: 0, isRepack: false },
      },
      languages: [
        { name: `English, see https://${trackerHost}/lang?apikey=${canary}` },
        { name: `/media/private/${canary}/english` },
      ],
      customFormats: [
        { name: `Freeleech, see https://${trackerHost}/formats?apikey=${canary}` },
        { name: `/media/private/${canary}/formats` },
      ],
      indexerFlags: [
        `Freeleech, see https://${trackerHost}/rules?apikey=${canary}`,
        `/media/private/${canary}/tv`,
      ],
      rejections: [
        {
          reason: `Blocked by the indexer, see https://${trackerHost}/rules?apikey=${canary}`,
          type: "permanent",
        },
      ],
    }));
  }

  it.each(["summary", "full"] as const)(
    "never lets a protected URL, magnet link, or key reach a %s result",
    async (detail) => {
      const { items } = await run(
        "sonarr",
        { ...episodeSearch, detail },
        poisoned(releases.sonarr),
      );

      const serialized = JSON.stringify(items);
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain(trackerHost);
      expect(serialized).not.toContain("magnet:");
      expect(serialized).not.toContain("downloadUrl");
      expect(serialized).not.toContain("://");
    },
  );

  /**
   * The same rule the rejection reasons follow: what is left of the name is
   * kept, and a name that was nothing but a protected value is dropped rather
   * than published as a bare marker.
   */
  it("scrubs an indexer flag rather than dropping the whole list", async () => {
    const { items } = await run(
      "sonarr",
      { ...episodeSearch, detail: "full" },
      poisoned(releases.sonarr),
    );

    expect(items[0]?.release.detail?.indexerFlags).toEqual(["Freeleech, see [redacted]"]);
  });

  /**
   * The same rule, on the field the import adapter has always scrubbed. A
   * custom format is named by the operator, so the two adapters must not
   * disagree about whether that name is sanitized on the way out.
   */
  it("scrubs a custom format rather than dropping the whole list", async () => {
    const { items } = await run(
      "sonarr",
      { ...episodeSearch, detail: "full" },
      poisoned(releases.sonarr),
    );

    expect(items[0]?.release.detail?.customFormats).toEqual(["Freeleech, see [redacted]"]);
  });

  it("scrubs every other label a release carries", async () => {
    const { items } = await run("sonarr", episodeSearch, poisoned(releases.sonarr));

    expect(items[0]?.release).toMatchObject({
      indexer: { name: "Example Indexer, see [redacted]" },
      releaseGroup: "EXAMPLEGRP [redacted]",
      quality: { name: "WEBDL-1080p, see [redacted]", source: "[redacted]" },
      languages: ["English, see [redacted]"],
    });
  });

  /**
   * Where the protected run sat inside a label is not a reason to publish one
   * name and discard another. Both of these carry the same thing — a word worth
   * reading and a link that may not travel — so both keep the word; only a name
   * that was nothing but the link is dropped, because it names nothing.
   */
  it("keeps what is left of a label whichever end the redaction landed on", async () => {
    const [record] = releases.sonarr;
    const { items } = await run("sonarr", { ...episodeSearch, detail: "full" }, [
      {
        ...record,
        indexerFlags: [
          `https://${trackerHost}/rules Freeleech`,
          `Halfleech, see https://${trackerHost}/rules`,
          `https://${trackerHost}/rules`,
        ],
      },
    ]);

    expect(items[0]?.release.detail?.indexerFlags).toEqual([
      "[redacted] Freeleech",
      "Halfleech, see [redacted]",
    ]);
  });

  it("drops a label that is nothing but redaction markers", async () => {
    const [record] = releases.sonarr;
    const { items } = await run("sonarr", { ...episodeSearch, detail: "full" }, [
      {
        ...record,
        indexerFlags: [`https://${trackerHost}/rules`, `/media/private/tv`],
      },
    ]);

    expect(items[0]?.release.detail?.indexerFlags).toBeUndefined();
  });

  /**
   * The tolerance is a property of the field, not of the value.
   *
   * A custom format is the one operator-authored name whose values carry a
   * separator by design — TRaSH Guides ships one called `Repack/Proper` — so it
   * publishes one. An indexer flag is `Freeleech` or `Internal` and has no such
   * shape, so the same string in that field is a path fragment as far as this
   * server can tell, and it is taken. Both are asserted in one test because the
   * divergence between them is the point.
   */
  it("publishes a separator only in the field whose taxonomy has one", async () => {
    const [record] = releases.sonarr;
    const { items } = await run("sonarr", { ...episodeSearch, detail: "full" }, [
      {
        ...record,
        customFormats: [{ name: "Repack/Proper" }, { name: "/media/private/tv" }],
        indexerFlags: ["Repack/Proper", "and/or", `/media/private/tv`],
      },
    ]);

    expect(items[0]?.release.detail?.customFormats).toEqual(["Repack/Proper"]);
    expect(items[0]?.release.detail?.indexerFlags).toBeUndefined();
  });

  it("keeps a release's own cache identity out of its indexer flags", async () => {
    const [record] = releases.sonarr;
    const { items } = await run("sonarr", { ...episodeSearch, detail: "full" }, [
      { ...record, indexerFlags: [`Freeleech ${record?.guid as string}`] },
    ]);

    expect(items[0]?.release.detail?.indexerFlags).toEqual(["Freeleech [redacted]"]);
  });

  /**
   * Radarr's own half of a release. The edition is a fragment Radarr parsed out
   * of the indexer's release name, so it is a label of the same provenance as
   * the release group and is held to the same rule; the matched movie titles are
   * Radarr's library metadata and are passed through as titles are everywhere
   * else in this project.
   */
  it("scrubs the edition Radarr parsed out of a release name", async () => {
    const [record] = releases.radarr;
    const { items } = await run("radarr", movieSearch, [
      { ...record, edition: `Director's Cut, see https://${trackerHost}/ed?id=${canary}` },
    ]);

    expect(items[0]?.release).toMatchObject({
      radarr: { edition: "Director's Cut, see [redacted]" },
    });
  });

  it("removes a link from a rejection rather than dropping the whole reason", async () => {
    const { items } = await run("sonarr", episodeSearch, poisoned(releases.sonarr));

    expect(items[0]?.release.decision?.rejections).toEqual([
      { reason: "Blocked by the indexer, see [redacted]", type: "permanent" },
    ]);
  });

  /**
   * Unlike a path, a link runs to whitespace and so takes a closing delimiter
   * with it. That is the deliberate direction — a URL query legitimately
   * contains brackets and commas, so stopping early would leave the tail of one
   * behind — and it is pinned here so the asymmetry with the path rule stays a
   * decision rather than drifting into an accident.
   */
  it("lets a link take its closing delimiter rather than leave part of a URL", async () => {
    const [record] = releases.sonarr;
    const { items } = await run("sonarr", episodeSearch, [
      {
        ...record,
        approved: false,
        rejections: [`Blocked (see https://${trackerHost}/rules?a=(1,2)&k=${canary}) now`],
      },
    ]);

    const reason = items[0]?.release.decision?.rejections[0]?.reason ?? "";
    expect(reason).toBe("Blocked (see [redacted] now");
    expect(reason).not.toContain(canary);
    expect(reason).not.toContain(trackerHost);
  });

  it("holds the upstream cache identity apart from anything a caller sees", async () => {
    const { items } = await run("sonarr", episodeSearch, poisoned(releases.sonarr));

    for (const item of items) {
      // The identity is the minimum a later grab needs, and nothing more.
      expect(Object.keys(item.identity).sort()).toEqual(["application", "guid", "indexerId"]);
      expect(item.identity.application).toBe("sonarr");
      expect(JSON.stringify(item.release)).not.toContain(item.identity.guid);
    }
  });

  it("takes a canonical server path out of a rejection without mangling prose", async () => {
    const [record] = releases.sonarr;
    const { items } = await run("sonarr", episodeSearch, [
      {
        ...record,
        approved: false,
        rejections: [
          "Only 1.2 GB is available on /media/private/tv, which is below the minimum",
          "Existing file C:\\Media\\Example Series\\file.mkv is not an upgrade",
          'Located at ("C:\\Media\\private.mkv") and (/var/lib/example/private.mkv)',
          "Quality WEBDL-1080p is not wanted in profile, 24/7 or otherwise",
        ],
      },
    ]);

    expect(items[0]?.release.decision?.rejections.map((entry) => entry.reason)).toEqual([
      "Only 1.2 GB is available on [redacted], which is below the minimum",
      // A path whose inner segments contain spaces is redacted whole.
      "Existing file [redacted] is not an upgrade",
      // A path a sentence wrapped keeps its wrapper and loses the path.
      'Located at ("[redacted]") and ([redacted])',
      // Ordinary prose containing a slash is left exactly as the instance wrote it.
      "Quality WEBDL-1080p is not wanted in profile, 24/7 or otherwise",
    ]);
  });

  /**
   * The delimiter a sentence closes a path with is the only thing that may
   * survive it. Tightening the run so prose stays balanced is exactly the change
   * that could leave a path fragment behind instead, so each terminator is
   * pinned rather than assumed.
   */
  it("leaves no path fragment whichever delimiter ends the path", async () => {
    const [record] = releases.sonarr;
    const secret = "private-library-fragment";
    const { items } = await run("sonarr", episodeSearch, [
      {
        ...record,
        approved: false,
        rejections: [
          `Quoted "/var/lib/${secret}/file.mkv" done`,
          `Paren (/var/lib/${secret}/file.mkv) done`,
          `Comma /var/lib/${secret}/file.mkv, done`,
          `Semicolon /var/lib/${secret}/file.mkv; done`,
          `Bracket [/var/lib/${secret}/file.mkv] done`,
          `End of string /var/lib/${secret}/file.mkv`,
        ],
      },
    ]);

    const reasons = items[0]?.release.decision?.rejections.map((entry) => entry.reason) ?? [];
    expect(reasons).toEqual([
      'Quoted "[redacted]" done',
      "Paren ([redacted]) done",
      "Comma [redacted], done",
      "Semicolon [redacted]; done",
      "Bracket [[redacted]] done",
      "End of string [redacted]",
    ]);
    // No terminator may buy back a piece of the path it closed.
    for (const reason of reasons) {
      expect(reason).not.toContain(secret);
      expect(reason).not.toContain("file.mkv");
      expect(reason).not.toContain("var");
    }
  });

  it("takes a credential and the release's own cache identity out of a rejection", async () => {
    const [record] = releases.sonarr;
    const { items } = await run("sonarr", episodeSearch, [
      {
        ...record,
        approved: false,
        rejections: [
          `Indexer refused the request, apikey=${canary} was not accepted`,
          // An application that names the release it refused would otherwise
          // publish the cache identity held beside the candidate.
          `Release ${record?.guid} was already grabbed`,
        ],
      },
    ]);

    expect(items[0]?.release.decision?.rejections.map((entry) => entry.reason)).toEqual([
      "Indexer refused the request, [redacted] was not accepted",
      "Release [redacted] was already grabbed",
    ]);
  });

  /**
   * A cookie or authorization header ends at a space that is *inside* it, so a
   * credential rule that stopped at the first whitespace would publish
   * everything after the first pair. The continuation has to look like a pair,
   * which is what keeps it from eating the prose after a semicolon.
   */
  it("follows a credential across the pairs it is written in, and no further", async () => {
    const [record] = releases.sonarr;
    const { items } = await run("sonarr", episodeSearch, [
      {
        ...record,
        approved: false,
        rejections: [
          `Indexer refused, cookie=sid=first; auth=${canary}; path=x now`,
          `Indexer refused, apikey=${canary}; and the quality is wrong`,
        ],
      },
    ]);

    const reasons = items[0]?.release.decision?.rejections.map((entry) => entry.reason) ?? [];
    expect(reasons).toEqual([
      "Indexer refused, [redacted] now",
      "Indexer refused, [redacted]; and the quality is wrong",
    ]);
    for (const reason of reasons) {
      expect(reason).not.toContain(canary);
    }
  });

  it("does not offer a release the instance only rejected temporarily", async () => {
    const [record] = releases.sonarr;
    const { items } = await run("sonarr", episodeSearch, [
      // An instance that states neither flag but marks the release temporarily
      // rejected has still refused it, empty rejection list or not.
      {
        ...record,
        approved: null,
        rejected: null,
        temporarilyRejected: true,
        rejections: [],
      },
    ]);

    expect(items[0]?.release.decision).toEqual({ approved: false, rejections: [] });
  });

  it("truncates a rejection an instance made unreasonably long", async () => {
    const [record] = releases.sonarr;
    const { items } = await run("sonarr", episodeSearch, [
      { ...record, approved: false, rejections: ["x".repeat(500)] },
    ]);

    const reason = items[0]?.release.decision?.rejections[0]?.reason ?? "";
    expect(reason).toHaveLength(300);
    expect(reason.endsWith("…")).toBe(true);
  });
});

describe("release search paging", () => {
  it("bounds a page and orders it as the instance ranked it", async () => {
    const harness = searchHarness("sonarr", () => jsonResponse(releases.sonarr));
    const ok = expectOk(
      await runReleaseSearch("sonarr", harness.client, {
        ...episodeSearch,
        paging: releasePaging(2),
      }),
    );

    expect(titlesOf(ok.data.items)).toEqual([
      "Example Series S01E01 1080p WEB-DL x264-EXAMPLEGRP",
      "Example Series S01E01 720p HDTV x264-OTHERGRP",
    ]);
    expect(ok.continuation).toMatchObject({ pageSize: 2, returned: 2, hasMore: true });
    // Neither application reports which of its indexers answered, so no
    // completeness is claimed for them.
    expect(ok.data.completeness).toBeUndefined();
  });
});
