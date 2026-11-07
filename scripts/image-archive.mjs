import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assert } from "./verification.mjs";

/**
 * Handles the one OCI archive CI builds for every platform, so the image that
 * is smoke-tested and the image that is published are the same bytes.
 *
 *   node scripts/image-archive.mjs check <archive>
 *     Asserts the archive holds one image index of exactly the published
 *     platforms, annotated with its source and description, that every blob
 *     the index reaches — manifests, configurations, and layers — is present
 *     and matches its digest and size, and prints `digest=<index digest>` for
 *     $GITHUB_OUTPUT. load and publish run the same validation first.
 *
 *   node scripts/image-archive.mjs load <archive> <os>/<arch> <local tag>
 *     Loads that platform's image from the archive into the Docker daemon,
 *     and asserts the loaded image has the archive's layers and configuration.
 *
 *   IMAGE_TAGS=<newline-separated tags> \
 *     node scripts/image-archive.mjs publish <archive> <expected digest>
 *     Copies the archive's index, unchanged, to every tag, and asserts each
 *     tag then resolves to the expected digest. Registry credentials are read
 *     from the Docker configuration a prior login wrote, never from arguments.
 *
 * It needs `tar`, `skopeo`, and, to load, `docker`; the GitHub-hosted Ubuntu
 * runner provides all three.
 */

const execFileAsync = promisify(execFile);
const publishedPlatforms = ["linux/amd64", "linux/arm64"];
const indexMediaType = "application/vnd.oci.image.index.v1+json";

async function run(command, args, { encoding = "utf8", timeoutMs = 600_000 } = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding,
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return stdout;
  } catch (error) {
    const stderr = error.stderr?.toString("utf8") ?? "";
    throw new Error(`${command} ${args[0]} failed\n${stderr}`, { cause: error });
  }
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The path of a descriptor's blob in an extracted OCI layout, after checking
 * the descriptor names a blob at all and that the blob is a regular file in
 * the layout rather than missing or a link to somewhere else.
 */
async function blobPath(layout, descriptor, label) {
  const digest = descriptor?.digest;
  assert(
    typeof digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(digest),
    `The ${label} descriptor names no sha256 digest: ${digest}`,
  );
  assert(
    Number.isSafeInteger(descriptor.size) && descriptor.size >= 0,
    `The ${label} descriptor for ${digest} declares no size`,
  );
  const file = path.join(layout, "blobs", "sha256", digest.slice(7));
  const stats = await lstat(file).catch(() => undefined);
  assert(stats?.isFile() === true, `Archive is missing the ${label} blob ${digest}`);
  return file;
}

/** A small JSON blob — an index, a manifest, a configuration — held to its descriptor. */
async function readBlob(layout, descriptor, label) {
  const bytes = await readFile(await blobPath(layout, descriptor, label));
  assert(
    bytes.length === descriptor.size && sha256(bytes) === descriptor.digest,
    `Archive ${label} blob ${descriptor.digest} does not match its digest and size`,
  );
  return JSON.parse(bytes.toString("utf8"));
}

/** A layer blob, hashed as it streams so no layer is ever held in memory. */
async function verifyLayer(layout, descriptor, label) {
  const file = await blobPath(layout, descriptor, label);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  assert(
    size === descriptor.size && `sha256:${hash.digest("hex")}` === descriptor.digest,
    `Archive ${label} blob ${descriptor.digest} does not match its digest and size`,
  );
}

/**
 * The archive's image index and, per platform, its manifest digest and parsed
 * configuration. Exactly the published platforms and nothing else: an
 * attestation or any other manifest in the index would be published without
 * being tested. Every descriptor followed from index.json down is required to
 * name a blob the archive holds, with the digest and size it declares, so an
 * archive missing or corrupting any layer is refused before anything loads or
 * publishes it.
 *
 * The archive is extracted once, to a directory removed again before this
 * returns, so each blob is read from disk rather than by rescanning the tar.
 */
async function describe(archive) {
  const layout = await mkdtemp(path.join(tmpdir(), "mcp-arr-layout-"));
  try {
    await run("tar", ["-xf", archive, "-C", layout]);
    const top = JSON.parse(await readFile(path.join(layout, "index.json"), "utf8"));
    assert(
      Array.isArray(top.manifests) && top.manifests.length === 1,
      `Archive index.json must name one image index, not ${top.manifests?.length}`,
    );
    const [descriptor] = top.manifests;
    assert(
      descriptor.mediaType === indexMediaType,
      `Archive holds ${descriptor.mediaType}, not an image index`,
    );
    const index = await readBlob(layout, descriptor, "image index");
    for (const name of [
      "org.opencontainers.image.source",
      "org.opencontainers.image.description",
    ]) {
      const annotation = index.annotations?.[name];
      assert(
        typeof annotation === "string" && annotation.trim() !== "",
        `Archive index carries no ${name} annotation`,
      );
    }
    const images = [];
    for (const entry of index.manifests ?? []) {
      const platform = `${entry.platform?.os}/${entry.platform?.architecture}`;
      const manifest = await readBlob(layout, entry, `${platform} manifest`);
      const config = await readBlob(layout, manifest.config, `${platform} configuration`);
      assert(
        Array.isArray(manifest.layers) && manifest.layers.length > 0,
        `The ${platform} manifest names no layers`,
      );
      for (const layer of manifest.layers) {
        await verifyLayer(layout, layer, `${platform} layer`);
      }
      images.push({ platform, manifest: entry.digest, config });
    }
    const platforms = images.map((image) => image.platform).sort();
    assert(
      JSON.stringify(platforms) === JSON.stringify(publishedPlatforms),
      `Archive index holds ${platforms.join(", ")}, not ${publishedPlatforms.join(", ")}`,
    );
    return { digest: descriptor.digest, images };
  } finally {
    await rm(layout, { recursive: true, force: true });
  }
}

async function check(archive) {
  const { digest } = await describe(archive);
  process.stdout.write(`digest=${digest}\n`);
}

/** JSON with object keys sorted at every depth, so equal values compare equal. */
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * skopeo writes the platform's image as a Docker archive, which `docker load`
 * reads on any daemon. The ID the daemon then assigns depends on the
 * conversion and on its image store, so it proves nothing; what the smoke test
 * runs is identified instead by its content. The loaded image must carry the
 * archive configuration's platform, exactly its uncompressed layer digests in
 * order, and every runtime setting that configuration declares.
 */
async function load(archive, platform, tag) {
  const { images } = await describe(archive);
  const image = images.find((candidate) => candidate.platform === platform);
  assert(image !== undefined, `Archive holds no ${platform} image`);
  const [os, architecture] = platform.split("/");
  const directory = await mkdtemp(path.join(tmpdir(), "mcp-arr-image-"));
  try {
    const dockerArchive = path.join(directory, "image.tar");
    await run("skopeo", [
      "copy",
      "--override-os",
      os,
      "--override-arch",
      architecture,
      `oci-archive:${archive}`,
      `docker-archive:${dockerArchive}:${tag}`,
    ]);
    await run("docker", ["load", "--input", dockerArchive]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const expected = image.config;
  const [loaded] = JSON.parse(await run("docker", ["image", "inspect", tag]));
  assert(
    `${loaded?.Os}/${loaded?.Architecture}` === `${expected.os}/${expected.architecture}`,
    `Loaded ${tag} is ${loaded?.Os}/${loaded?.Architecture}, not ${expected.os}/${expected.architecture}`,
  );
  const layers = expected.rootfs?.diff_ids ?? [];
  assert(layers.length > 0, `Archive's ${platform} configuration names no layers`);
  assert(
    canonical(loaded.RootFS?.Layers) === canonical(layers),
    `Loaded ${tag} does not carry the archive's ${platform} layers`,
  );
  for (const [key, value] of Object.entries(expected.config ?? {})) {
    assert(
      canonical(loaded.Config?.[key]) === canonical(value),
      `Loaded ${tag} has a different ${key} than the archive's ${platform} configuration`,
    );
  }
  process.stdout.write(`Loaded ${platform} image ${image.manifest} as ${tag}\n`);
}

function dockerAuthFile() {
  const directory = process.env.DOCKER_CONFIG ?? path.join(homedir(), ".docker");
  return path.join(directory, "config.json");
}

async function publish(archive, expectedDigest) {
  const tags = (process.env.IMAGE_TAGS ?? "")
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  assert(tags.length > 0, "IMAGE_TAGS names no tag to publish");
  const { digest } = await describe(archive);
  assert(
    digest === expectedDigest,
    `Archive index is ${digest}, not the verified ${expectedDigest}`,
  );
  const authFile = dockerAuthFile();
  process.stdout.write(`${(await run("skopeo", ["--version"])).trim()}\n`);
  for (const tag of tags) {
    // --preserve-digests refuses any copy that would change a manifest, so
    // the registry receives the archive's index byte for byte or nothing.
    await run("skopeo", [
      "copy",
      "--all",
      "--preserve-digests",
      "--retry-times",
      "3",
      "--dest-authfile",
      authFile,
      `oci-archive:${archive}`,
      `docker://${tag}`,
    ]);
    const remote = sha256(
      await run(
        "skopeo",
        ["inspect", "--raw", "--retry-times", "3", "--authfile", authFile, `docker://${tag}`],
        { encoding: "buffer" },
      ),
    );
    assert(remote === digest, `${tag} resolves to ${remote}, not ${digest}`);
    process.stdout.write(`Published ${tag} at ${digest}\n`);
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "check" && args.length === 1) {
  await check(args[0]);
} else if (command === "load" && args.length === 3) {
  await load(args[0], args[1], args[2]);
} else if (command === "publish" && args.length === 2) {
  await publish(args[0], args[1]);
} else {
  throw new Error(
    "Usage: node scripts/image-archive.mjs check <archive> | load <archive> <os>/<arch> <tag> | publish <archive> <digest>",
  );
}
