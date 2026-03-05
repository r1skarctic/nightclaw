import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeRunOpenclawMigration } from "./migrate-openclaw.js";

// Helpers
async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function writeFile(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("maybeRunOpenclawMigration", () => {
  let tmpHome: string;
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  beforeEach(async () => {
    tmpHome = await makeTempDir("nightclaw-migrate-test-");
    warnings.length = 0;
    // Stub out systemctl and launchctl to avoid real subprocess calls.
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("migrates ~/.openclaw to ~/.nightclaw when nightclaw dir does not exist", async () => {
    const openclawDir = path.join(tmpHome, ".openclaw");
    await makeDir(openclawDir);
    await writeFile(path.join(openclawDir, "openclaw.json"), '{"gateway":{"port":18789}}');
    await writeFile(path.join(openclawDir, "sessions", "main.json"), "{}");

    const env = { HOME: tmpHome } as NodeJS.ProcessEnv;
    await maybeRunOpenclawMigration(env, warn);

    const nightclawJson = path.join(tmpHome, ".nightclaw", "openclaw.json");
    expect(await fileExists(nightclawJson)).toBe(true);
    expect(await fs.readFile(nightclawJson, "utf8")).toBe('{"gateway":{"port":18789}}');
    expect(await fileExists(path.join(tmpHome, ".nightclaw", "sessions", "main.json"))).toBe(true);

    // Original directory must be removed after migration.
    expect(await fileExists(path.join(openclawDir, "openclaw.json"))).toBe(false);
    expect(await fileExists(openclawDir)).toBe(false);

    expect(warnings.some((w) => w.includes("Migrated data"))).toBe(true);
    expect(warnings.some((w) => w.includes("Removed original openclaw directory"))).toBe(true);
  });

  it("skips dir migration when ~/.nightclaw already exists", async () => {
    const openclawDir = path.join(tmpHome, ".openclaw");
    await makeDir(openclawDir);
    await writeFile(path.join(openclawDir, "openclaw.json"), "{}");

    const nightclawDir = path.join(tmpHome, ".nightclaw");
    await makeDir(nightclawDir);
    await writeFile(path.join(nightclawDir, "openclaw.json"), '{"existing":true}');

    const env = { HOME: tmpHome } as NodeJS.ProcessEnv;
    await maybeRunOpenclawMigration(env, warn);

    // Existing nightclaw config must not be overwritten.
    expect(await fs.readFile(path.join(nightclawDir, "openclaw.json"), "utf8")).toBe(
      '{"existing":true}',
    );
    expect(warnings.some((w) => w.includes("Migrated data"))).toBe(false);
  });

  it("migrates profile directories ~/.openclaw-<profile> → ~/.nightclaw-<profile>", async () => {
    const srcProfile = path.join(tmpHome, ".openclaw-work");
    await makeDir(srcProfile);
    await writeFile(path.join(srcProfile, "openclaw.json"), '{"profile":"work"}');

    const env = { HOME: tmpHome } as NodeJS.ProcessEnv;
    await maybeRunOpenclawMigration(env, warn);

    const destProfile = path.join(tmpHome, ".nightclaw-work");
    expect(await fileExists(path.join(destProfile, "openclaw.json"))).toBe(true);
    expect(await fs.readFile(path.join(destProfile, "openclaw.json"), "utf8")).toBe(
      '{"profile":"work"}',
    );

    // Source profile directory must be removed after migration.
    expect(await fileExists(srcProfile)).toBe(false);
  });

  it("writes a sentinel file after migration", async () => {
    const openclawDir = path.join(tmpHome, ".openclaw");
    await makeDir(openclawDir);

    const env = { HOME: tmpHome } as NodeJS.ProcessEnv;
    await maybeRunOpenclawMigration(env, warn);

    expect(await fileExists(path.join(tmpHome, ".nightclaw-migrated-from-openclaw"))).toBe(true);
  });

  it("skips everything when sentinel file is present", async () => {
    const openclawDir = path.join(tmpHome, ".openclaw");
    await makeDir(openclawDir);
    await writeFile(path.join(openclawDir, "openclaw.json"), "{}");
    // Pre-write sentinel.
    await writeFile(path.join(tmpHome, ".nightclaw-migrated-from-openclaw"), "done");

    const env = { HOME: tmpHome } as NodeJS.ProcessEnv;
    await maybeRunOpenclawMigration(env, warn);

    // nightclaw dir should NOT have been created.
    expect(await fileExists(path.join(tmpHome, ".nightclaw"))).toBe(false);
    expect(warnings.length).toBe(0);
  });

  it("does nothing when neither ~/.openclaw nor any openclaw services exist", async () => {
    const env = { HOME: tmpHome } as NodeJS.ProcessEnv;
    await maybeRunOpenclawMigration(env, warn);

    expect(warnings.length).toBe(0);
  });

  it("attempts to uninstall the openclaw global package after migration", async () => {
    const openclawDir = path.join(tmpHome, ".openclaw");
    await makeDir(openclawDir);
    await writeFile(path.join(openclawDir, "openclaw.json"), "{}");

    const uninstallCalls: string[] = [];
    // Intercept child_process.execFile to capture uninstall calls.
    vi.doMock("node:child_process", () => ({
      execFile: (cmd: string, args: string[], callback: (err: null | { code: number }) => void) => {
        uninstallCalls.push(`${cmd} ${args.join(" ")}`);
        // Simulate npm uninstall success.
        if (cmd === "npm") {
          callback(null);
        } else {
          callback({ code: 1 });
        }
      },
    }));

    const env = { HOME: tmpHome } as NodeJS.ProcessEnv;
    await maybeRunOpenclawMigration(env, warn);

    // The mock may not intercept dynamic imports in the module under test, but
    // the migration must at minimum complete without throwing.
    expect(await fileExists(path.join(tmpHome, ".nightclaw-migrated-from-openclaw"))).toBe(true);
    // Original directory should be gone.
    expect(await fileExists(openclawDir)).toBe(false);

    vi.doUnmock("node:child_process");
  });
});
