import { describe, expect, it } from "vitest";
import { createTitleLocks } from "../src/state/title-locks.js";

describe("title locks", () => {
  it("runs one title's actions in order, each after the last has settled", async () => {
    const locks = createTitleLocks();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = locks.run("movie:1", async () => {
      order.push("first started");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("first settled");
      return "first";
    });
    const second = locks.run("movie:1", async () => {
      order.push("second started");
      return "second";
    });
    // Another title's action does not wait behind this one.
    await expect(locks.run("movie:2", async () => "other")).resolves.toBe("other");
    expect(order).toEqual(["first started"]);

    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(order).toEqual(["first started", "first settled", "second started"]);
  });

  it("lets the next action run after one that failed, and keeps nothing once all settle", async () => {
    const locks = createTitleLocks();
    const failed = locks.run("series:1", async () => {
      throw new Error("refused");
    });
    const next = locks.run("series:1", async () => "ran");

    await expect(failed).rejects.toThrow("refused");
    await expect(next).resolves.toBe("ran");
    await Promise.resolve();
    expect(locks.size).toBe(0);
  });
});
