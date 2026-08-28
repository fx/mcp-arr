import { z } from "zod";
import { toolResultSchema } from "../results.js";
import { queryBaseShape } from "./common.js";
import { configurationViewSchema } from "./configuration-results.js";
import { variantUnion } from "./publish.js";

/**
 * The typed observation domains. Observation is allowlisted on the way out:
 * unknown upstream fields are dropped from the result and secret fields are
 * reported as configured or unconfigured rather than by value.
 */
export const configObserveInputSchema = variantUnion(
  z.discriminatedUnion("domain", [
    z.strictObject({ domain: z.literal("indexers"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("download_clients"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("applications"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("notifications"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("import_lists"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("metadata"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("proxies"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("quality_profiles"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("custom_formats"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("release_profiles"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("delay_profiles"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("app_profiles"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("tags"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("root_folders"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("remote_path_mappings"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("import_list_exclusions"), ...queryBaseShape }),
  ]),
);

export const configObserveOutputSchema = toolResultSchema({ data: configurationViewSchema });
