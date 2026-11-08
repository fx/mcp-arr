import type {
  MediaApplication,
  MediaLookupKind,
  MediaRecordKind,
} from "../../adapters/library/model.js";
import type { MediaDefaultKind } from "../../config/environment.js";

/**
 * The two kinds of title the `media` toolset talks about, and everything the
 * kind decides on the way upstream.
 *
 * A caller never names an application: the kind selects it. That pairing, and
 * the words a result uses for each kind, are stated once here so no tool can
 * route a kind to one application and describe it as another.
 */
export const titleKinds = ["movie", "series"] as const satisfies readonly MediaDefaultKind[];

export type TitleKind = (typeof titleKinds)[number];

interface KindRoute {
  readonly application: MediaApplication;
  /** The lookup that answers for this kind's metadata identifier. */
  readonly lookup: MediaLookupKind;
  /** The library record a title of this kind becomes. */
  readonly record: MediaRecordKind;
  /** How a sentence names one title of this kind. */
  readonly singular: string;
  /** How a sentence names titles of this kind, in the plural. */
  readonly plural: string;
  /** The same, capitalized to open a sentence. */
  readonly pluralSentence: string;
}

export const kindRoutes: Readonly<Record<TitleKind, KindRoute>> = {
  movie: {
    application: "radarr",
    lookup: "movie_lookup",
    record: "movie",
    singular: "movie",
    plural: "movies",
    pluralSentence: "Movies",
  },
  series: {
    application: "sonarr",
    lookup: "series_lookup",
    record: "series",
    singular: "series",
    plural: "TV series",
    pluralSentence: "TV series",
  },
};
