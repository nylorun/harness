import { describe, expect, it, vi } from "vitest";
import { createProject } from "../dist/project.js";
import { starterFiles } from "../dist/scaffold.js";
import type { Compatibility, CreatorDependencies } from "../src/contracts.js";

const compatibility: Compatibility = {
  harness: "1.2.3",
  studio: "4.5.6",
  runtime: "7.8.9",
};

describe("starter template", () => {
  it("installs the known-good stack and contains no hosting implementation", async () => {
    const files = await starterFiles(compatibility, true);
    const manifest = JSON.parse(files["package.json"]!);
    expect(manifest.dependencies["@nylorun/harness"]).toBe("1.2.3");
    expect(manifest.dependencies["@nylorun/runtime"]).toBe("7.8.9");
    expect(manifest.devDependencies["@nylorun/studio"]).toBe("4.5.6");
    expect(
      Object.keys(files)
        .filter((path) => path.endsWith(".ts"))
        .sort(),
    ).toEqual([
      "agent/assistant/agent.ts",
      "agent/registry.ts",
      "nylorun.config.ts",
    ]);
    expect(files[".env/auth.json"]).toBeUndefined();
    expect(files["nylorun.config.ts"]).toContain("defineRuntime({ agents })");
  });
  it("creates a functional headless shell", async () => {
    const files = await starterFiles(compatibility, false);
    const manifest = JSON.parse(files["package.json"]!);
    expect(manifest.devDependencies["@nylorun/studio"]).toBeUndefined();
    expect(manifest.scripts.dev).toBe("nylorun dev --no-studio");
    expect(manifest.scripts.start).toBe("nylorun start");
  });
  it("renders ignore files under their real names so npm cannot drop them", async () => {
    const files = await starterFiles(compatibility, true);
    expect(files[".gitignore"]).toContain("node_modules/");
    expect(files[".env/.gitignore"]).toContain("*");
    expect(Object.keys(files).some((path) => path.includes("_gitignore"))).toBe(false);
  });
});

describe("project creation", () => {
  it("does not overwrite an existing target", async () => {
    const dependencies: CreatorDependencies = {
      currentDirectory: () => "/workspace",
      isInteractive: () => true,
      log: () => {},
      exists: async () => true,
      makeDirectory: async () => undefined,
      rename: async () => undefined,
      remove: async () => undefined,
      write: async () => undefined,
      run: async () => ({ status: 0 }),
    };
    await expect(
      createProject(
        { directory: "taken", studio: true, open: true, yes: true },
        compatibility,
        dependencies,
      ),
    ).rejects.toThrow("already exists");
  });

  it("rejects a target outside the current directory", async () => {
    const dependencies: CreatorDependencies = {
      currentDirectory: () => "/workspace",
      isInteractive: () => true,
      log: () => {},
      exists: async () => false,
      makeDirectory: async () => undefined,
      rename: async () => undefined,
      remove: async () => undefined,
      write: async () => undefined,
      run: async () => ({ status: 0 }),
    };
    await expect(
      createProject(
        { directory: "../outside", studio: true, open: true, yes: true },
        compatibility,
        dependencies,
      ),
    ).rejects.toThrow("new child");
  });
});

it("renders a fresh project before installation and forwards headless/browser choices", async () => {
  const files = new Map<string, string>();
  const commands: unknown[] = [];
  let renamed = false;
  await createProject(
    { directory: "demo", studio: false, open: false, yes: true },
    compatibility,
    {
      currentDirectory: () => "/workspace",
      isInteractive: () => true,
      log: () => {},
      exists: async () => false,
      makeDirectory: async () => {},
      remove: async () => {},
      write: async (path, content) => {
        files.set(path, content);
      },
      rename: async () => {
        renamed = true;
      },
      run: async (command, args, directory) => {
        expect(renamed).toBe(true);
        commands.push([command, args, directory]);
        return { status: 0 };
      },
    },
  );
  expect(
    [...files.keys()].some((path) => path.endsWith("/nylorun.config.ts")),
  ).toBe(true);
  expect(commands).toEqual([
    ["npm", ["install", "--yes"], "/workspace/demo"],
    ["npm", ["run", "configure"], "/workspace/demo"],
    ["npm", ["run", "dev", "--", "--no-open"], "/workspace/demo"],
  ]);
});

function fixture() {
  return {
    currentDirectory: () => "/workspace",
    isInteractive: () => true,
    log: vi.fn(),
    exists: vi.fn(async () => false),
    makeDirectory: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    write: vi.fn(async () => {}),
    run: vi.fn<CreatorDependencies["run"]>(async () => ({ status: 0 })),
  };
}
const options = { directory: "my agent", studio: true, open: true, yes: false };

it("rejects noninteractive creation before any writes or installation", async () => {
  const deps = fixture();
  deps.isInteractive = () => false;
  await expect(createProject(options, compatibility, deps)).rejects.toThrow(
    "--skip-config",
  );
  expect(deps.makeDirectory).not.toHaveBeenCalled();
  expect(deps.write).not.toHaveBeenCalled();
  expect(deps.run).not.toHaveBeenCalled();
});

it("explicit skipping starts development without interactive configuration", async () => {
  const deps = fixture();
  deps.isInteractive = () => false;
  await createProject({ ...options, skipConfig: true }, compatibility, deps);
  expect(deps.run.mock.calls.map((call) => call[1])).toEqual([
    ["install"],
    ["run", "dev"],
  ]);
  expect(deps.log.mock.calls.flat().join("\n")).toContain(
    "cd '/workspace/my agent'\nnpm run configure",
  );
});

it.each([
  ["installation", 0, ["install"]],
  ["configuration", 1, ["install", "run configure"]],
])(
  "retains the project and does not advance after %s failure",
  async (_name, failAt, commands) => {
    const deps = fixture();
    let index = 0;
    deps.run.mockImplementation(async () => ({
      status: index++ === failAt ? 1 : 0,
    }));
    await expect(createProject(options, compatibility, deps)).rejects.toThrow(
      "cd '/workspace/my agent'\n",
    );
    expect(deps.run.mock.calls.map((call) => call[1].join(" "))).toEqual(
      commands,
    );
    expect(deps.remove).not.toHaveBeenCalled();
  },
);

it.each([
  [{ status: 130 }, 130],
  [{ status: null, signal: "SIGTERM" as const }, 143],
])(
  "preserves cancellation status and never starts development",
  async (result, exitCode) => {
    const deps = fixture();
    deps.run.mockResolvedValueOnce({ status: 0 }).mockResolvedValueOnce(result);
    await expect(
      createProject(options, compatibility, deps),
    ).rejects.toMatchObject({ exitCode });
    expect(deps.run).toHaveBeenCalledTimes(2);
    expect(deps.remove).not.toHaveBeenCalled();
  },
);

it("shows recovery instructions when spawning configure fails", async () => {
  const deps = fixture();
  deps.run
    .mockResolvedValueOnce({ status: 0 })
    .mockRejectedValueOnce(new Error("spawn failed"));
  await expect(createProject(options, compatibility, deps)).rejects.toThrow(
    "npm run configure\nnpm run dev",
  );
  expect(deps.run).toHaveBeenCalledTimes(2);
});
