import { expect, it, vi } from "vitest";
import { EventDelivery } from "../src/server/delivery.js";

it("suppresses overflowing previews while preserving authoritative delivery", async () => {
  const abort = vi.fn();
  const delivery = new EventDelivery(abort, { previewBytes: 120 });
  delivery.push({ text: "short" }, "model");
  delivery.push({ text: "x".repeat(200) }, "model");
  delivery.push({ text: "must be suppressed" }, "model");
  delivery.push({ type: "final", text: "accepted" });
  delivery.end();
  const text = await delivery.response.text();
  expect(text).toContain("nylorun.preview.incomplete");
  expect(text).toContain("accepted");
  expect(text).not.toContain("must be suppressed");
  expect(abort).not.toHaveBeenCalled();
});
it("terminates a slow authoritative subscription and cancels attached work", async () => {
  const abort = vi.fn();
  const delivery = new EventDelivery(abort, { eventCount: 1 });
  delivery.push({ type: "one" });
  delivery.push({ type: "two" });
  await expect(delivery.response.text()).rejects.toThrow("delivery limits");
  expect(abort).toHaveBeenCalledOnce();
});
it("cancels work when its reader disconnects", async () => {
  const abort = vi.fn();
  const delivery = new EventDelivery(abort);
  await delivery.response.body!.cancel();
  expect(abort).toHaveBeenCalledOnce();
});
