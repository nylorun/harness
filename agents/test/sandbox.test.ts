import { Agent } from "@nylorun/core/define";
import { AgentManifestSchema } from "@nylorun/core/contracts";
import { expect, it } from "vitest";
import { sandbox, SandboxError } from "../src/sandbox/index.js";

it("adds a sandbox capability with the six built-in tools", () => {
  const agent = Agent({ id: "analyst", instructions: "Analyse data." })
    .use(sandbox())
    .build();
  const capability = agent.manifest.capabilities.find((item) => item.id === "sandbox");
  expect(capability?.sandbox).toEqual({});
  expect(capability?.tools?.map((item) => item.name)).toEqual([
    "bash",
    "read",
    "write",
    "edit",
    "grep",
    "glob",
  ]);
  expect(capability?.instructions?.[0]).toContain("/workspace");
  expect(AgentManifestSchema.safeParse(agent.manifest).success).toBe(true);
});

it("carries requirements as plain data", () => {
  const declaration = sandbox(
    {
      image: "node:24",
      network: { preset: "none", allow: ["api.github.com"] },
      resources: { cpus: 2, memory: "2GiB" },
      idle: "5m",
    },
    { id: "computer" }
  );
  expect(declaration.id).toBe("computer");
  expect(declaration.sandbox).toEqual({
    image: "node:24",
    network: { preset: "none", allow: ["api.github.com"] },
    resources: { cpus: 2, memory: "2GiB" },
    idle: "5m",
  });
  expect(Object.isFrozen(declaration.sandbox)).toBe(true);
  expect(JSON.parse(JSON.stringify(declaration.sandbox))).toEqual(declaration.sandbox);
});

it("teaches when a deferred option is used", () => {
  expect(() => sandbox({ setup: ["pip install pandas"] } as never)).toThrow(
    /not supported in this version/
  );
  try {
    sandbox({ secrets: {} } as never);
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).code).toBe("sandbox.unsupported");
  }
});

it("rejects invalid values with the fix", () => {
  expect(() => sandbox({ idle: "later" })).toThrow(/duration/);
  expect(() => sandbox({ resources: { memory: "2GB" } })).toThrow(/2GiB/);
  expect(() => sandbox({ network: { allow: ["https://api.github.com"] } })).toThrow(/host name/);
  expect(() => sandbox({ network: { preset: "everything" as never } })).toThrow(/none, dev, open/);
  expect(() => sandbox({ bogus: 1 } as never)).toThrow(/Unknown sandbox option/);
});
