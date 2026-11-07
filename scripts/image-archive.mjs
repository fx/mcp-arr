import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
 *     platforms, and prints `digest=<index digest>` for $GITHUB_OUTPUT.
 *
 *   node scripts/image-archive.mjs load <archive> <os>/<arch> <local tag>
 *     Loads that platform's image from the archive into the Docker daemon,
 *     and asserts the loaded image is the archive's.
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
 * One member of the archive, by its path in the OCI layout. A tar writer may
 * or may not prefix member names with `./`, so the name is matched either way.
 */
const listings = new Map();

async function readMember(archive, name) {
  if (!listings.has(archive)) {
    listings.set(archive, (await run("tar", ["-tf", archive])).split("\n"));
  }
  const member = listings.get(archive).find((entry) => entry.replace(/^\.\//u, "") === name);
  assert(member !== undefined, `Archive has no ${name}`);
  return run("tar", ["-xOf", archive, member], { encoding: "buffer" });
}

/** One blob of the archive, held to the digest it is named by. */
async function readBlob(archive, digest) {
  assert(/^sha256:[0-9a-f]{64}$/u.test(digest), `Unexpected digest ${digest}`);
  const bytes = await readMember(archive, `blobs/sha256/${digest.slice(7)}`);
  assert(sha256(bytes) === digest, `Archive blob ${digest} does not match its digest`);
  return JSON.parse(bytes.toString("utf8"));
}

/**
 * The archive's image index and, per platform, its manifest and configuration
 * digests. Exactly the published platforms and nothing else: an attestation or
 * any other manifest in the index would be published without being tested.
 */
async function describe(archive) {
  const top = JSON.parse((await readMember(archive, "index.json")).toString("utf8"));
  assert(
    Array.isArray(top.manifests) && top.manifests.length === 1,
    `Archive index.json must name one image index, not ${top.manifests?.length}`,
  );
  const [descriptor] = top.manifests;
  assert(
    descriptor.mediaType === indexMediaType,
    `Archive holds ${descriptor.mediaType}, not an image index`,
  );
  const index = await readBlob(archive, descriptor.digest);
  const images = await Promise.all(
    (index.manifests ?? []).map(async (entry) => ({
      platform: `${entry.platform?.os}/${entry.platform?.architecture}`,
      manifest: entry.digest,
      config: (await readBlob(archive, entry.digest)).config?.digest,
    })),
  );
  const platforms = images.map((image) => image.platform).sort();
  assert(
    JSON.stringify(platforms) === JSON.stringify(publishedPlatforms),
    `Archive index holds ${platforms.join(", ")}, not ${publishedPlatforms.join(", ")}`,
  );
  return { digest: descriptor.digest, images };
}

async function check(archive) {
  const { digest } = await describe(archive);
  process.stdout.write(`digest=${digest}\n`);
}

/**
 * skopeo writes the platform's image as a Docker archive, which `docker load`
 * reads on any daemon. The loaded image's ID is its configuration digest — or,
 * on a containerd image store, its manifest digest — so either one ties what
 * the smoke test runs to this archive.
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
  const loaded = (await run("docker", ["image", "inspect", "--format", "{{.Id}}", tag])).trim();
  assert(
    loaded === image.config || loaded === image.manifest,
    `Loaded ${tag} is ${loaded}, not the archive's ${platform} image ${image.manifest}`,
  );
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
