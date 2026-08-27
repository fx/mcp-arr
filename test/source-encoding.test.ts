import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A structural check on the source itself, in the shape `fixture-contract`
 * already uses for the recorded fixtures.
 *
 * A single NUL byte makes git classify a file as binary, and a binary file
 * cannot be diffed or reviewed: `git diff` reports `Bin 0 -> 13931 bytes` and
 * shows nothing else. That is how one reached `test/sonarr-activity.test.ts` —
 * an escape written as a raw byte — and it survived every other gate, because
 * the file still parsed, still type-checked, and still passed. Nothing but a
 * check on the bytes would have caught it, so this is that check.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The tracked files under the source directories.
 *
 * Tracked is the property that matters: an untracked scratch file is nobody's
 * problem, and a tracked one is what a reviewer has to be able to read. The
 * list comes from git rather than from a directory walk so the two can never
 * disagree, and it is NUL-delimited because a file name may contain anything
 * else — including the newline that would otherwise split it in two.
 */
function trackedSourceFiles(): readonly string[] {
  const output = execFileSync("git", ["ls-files", "-z", "--", "src", "test"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.split("\0").filter((name) => name !== "");
}

describe("source encoding", () => {
  it("has no NUL byte in any tracked source file", async () => {
    const files = trackedSourceFiles();
    // The list itself is checked: a query that matched nothing would make every
    // assertion below vacuous, which is the same defect this file exists for.
    expect(files.length).toBeGreaterThan(20);

    const offending = await Promise.all(
      files.map(async (name) => {
        // A file git still tracks but that is gone from disk is a deletion in
        // progress, not a finding. Reporting it as one would crash this check
        // with an ENOENT that says nothing about NUL bytes.
        let contents: Buffer;
        try {
          contents = await readFile(path.join(repositoryRoot, name));
        } catch {
          return undefined;
        }
        const offset = contents.indexOf(0);
        return offset === -1 ? undefined : `${name} (byte ${String(offset)})`;
      }),
    );

    expect(offending.filter((entry) => entry !== undefined)).toEqual([]);
  });

  it("classifies every tracked source file as text", () => {
    // The property a reviewer actually depends on, asserted directly rather
    // than inferred from the byte scan above — it also catches content that is
    // NUL-free and still undiffable. The working-tree column is the one read,
    // because that is the copy the author just wrote and the same bytes the
    // scan above sees; the index column would instead report whatever was last
    // staged, and fail on a fix that is correct but not yet added.
    const output = execFileSync("git", ["ls-files", "--eol", "-z", "--", "src", "test"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });

    const binary = output
      .split("\0")
      .filter((entry) => entry !== "")
      .filter((entry) => /(?:^|\s)w\/-text(?:\s|$)/u.test(entry));

    expect(binary).toEqual([]);
  });
});
