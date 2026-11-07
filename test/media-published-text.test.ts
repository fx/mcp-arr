import { describe, expect, it } from "vitest";
import { createAdapterRegistry } from "../src/adapters/registry.js";
import { parseEnvironment } from "../src/config/environment.js";
import type { MediaContext } from "../src/tools/media/context.js";
import { publishedText } from "../src/tools/media/published-text.js";
import { noMediaDefaults } from "./support/media.js";

/**
 * Every way taking a configured key out of upstream text could change how the
 * sanitizer reads the rest of it.
 *
 * The key stands in for a value an operator chose: it matches no credential
 * shape, so only the exact rule knows it is one. Each case asserts what the
 * text becomes and that nothing it must not carry survives.
 */

const key = "Plain-Key-Value-77";

const context: MediaContext = {
  registry: createAdapterRegistry(
    parseEnvironment({ RADARR_URL: "https://radarr.example.invalid", RADARR_API_KEY: key }),
  ),
  defaults: noMediaDefaults,
};

function publish(text: string): string | undefined {
  return publishedText(context, text);
}

describe("publishedText", () => {
  it("redacts a URL whole whichever part of it the key is", () => {
    for (const text of [
      `https://${key}:private-password@internal.example/path`,
      `https://user:${key}@internal.example/path`,
      `https://internal.example/feed?apikey=${key}&x=1`,
      `https://internal.example/${key}/feed`,
      `https://${key}.internal.example`,
    ]) {
      expect(publish(text), text).toBe("[redacted url]");
    }
  });

  it("keeps the words around a URL carrying the key", () => {
    expect(publish(`Example https://user:${key}@internal.example/path Title`)).toBe(
      "Example [redacted url] Title",
    );
  });

  it("marks the key in an assignment, a bearer value, or a scheme-less credential", () => {
    expect(publish(`apikey=${key}&x=1`)).toBe("apikey=[redacted key]&x=1");
    expect(publish(`Bearer ${key}`)).toBe("Bearer [redacted key]");
    expect(publish(`user:${key}@internal`)).toBe("user:[redacted key]@internal");
  });

  it("takes a long run the key is glued into as one identifier", () => {
    expect(publish(`Example ${key}0123456789abcdef0123456789abcdef`)).toBe("Example [redacted id]");
  });

  it("takes a path the key is part of as one path", () => {
    expect(publish(`Example /media/${key}/file.mkv`)).toBe("Example [redacted path]");
  });

  it("catches a key a hidden character split, once the sanitizer makes it whole", () => {
    expect(publish(`Example Plain-Key\u200b-Value-77 Title`)).toBe("Example [redacted key] Title");
  });

  it("leaves no readable part of a key the length bound would have cut", () => {
    const padding = "x ".repeat(96);
    const published = publish(`${padding}${key} tail`) ?? "";

    expect(published.toLowerCase()).not.toContain("plain");
    expect(published).not.toContain("Key-Value");
  });

  it("leaves text without the key exactly as the sanitizer does", () => {
    expect(publish("Example Plain Title")).toBe("Example Plain Title");
    expect(publish("Example Zq0123456789abqZ Title")).toBe("Example Zq0123456789abqZ Title");
  });
});
