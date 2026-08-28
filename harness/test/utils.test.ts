import { describe, expect, it } from "vitest";
import { digest } from "../src/utils/digest.js";
import { createId } from "../src/utils/ids.js";
import { createObserverRegistry } from "../src/utils/observe.js";

describe("portable utility primitives", () => {
  it("creates prefixed UUID v4 identifiers with Web Crypto", () => {
    expect(createId("session")).toMatch(
      /^session_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("preserves the synchronous lowercase SHA-256 digest format", () => {
    expect(digest({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });
});

describe("observer registry", () => {
  it("does not invoke an emit factory when no listeners are registered", () => {
    const registry = createObserverRegistry();
    let calls = 0;
    registry.emit(() => {
      calls += 1;
      return { type: "session.stopped", reason: "unused" };
    });
    expect(calls).toBe(0);
  });

  it("invokes an emit factory once when a listener exists", () => {
    const registry = createObserverRegistry();
    const types: string[] = [];
    registry.observe((event) => types.push(event.type));
    let calls = 0;
    registry.emit(() => {
      calls += 1;
      return { type: "session.stopped", reason: "done" };
    });
    expect(calls).toBe(1);
    expect(types).toEqual(["session.stopped"]);
  });

  it("skips the next factory after the last listener unsubscribes", () => {
    const registry = createObserverRegistry();
    const unsubscribe = registry.observe(() => undefined);
    unsubscribe();
    let calls = 0;
    registry.emit(() => {
      calls += 1;
      return { type: "session.stopped", reason: "unused" };
    });
    expect(calls).toBe(0);
  });
});
