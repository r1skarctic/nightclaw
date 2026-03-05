/**
 * One-time migration helper: OpenClaw → NightClaw.
 *
 * Runs automatically on the first CLI invocation after upgrade.  It:
 *   1. Copies ~/.openclaw (and ~/.openclaw-<profile>) to ~/.nightclaw (and
 *      ~/.nightclaw-<profile>) when the nightclaw directory does not yet exist,
 *      then deletes the original openclaw directories.
 *   2. Stops and disables any running openclaw systemd user services, installs
 *      the matching nightclaw service units, then re-enables and re-starts them
 *      when they were originally active.
 *   3. Unloads and removes any openclaw launchd LaunchAgent plists, then
 *      re-loads the new nightclaw equivalents (macOS only).
 *   4. Attempts to uninstall the openclaw global npm/pnpm/bun package so the
 *      old binary can no longer be accidentally triggered.
 *
 * All errors are caught and printed as warnings so the migration never blocks
 * normal CLI operation.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ─── helpers ─────────────────────────────────────────────────────────────────

function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await copyRecursive(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }),
  );
}

// ─── directory migration ──────────────────────────────────────────────────────

/**
 * Migrate a single directory pair (src → dest), then delete the source.
 * Returns true when a migration was performed, false when skipped.
 */
async function migrateDirectory(src: string, dest: string, warn: (m: string) => void) {
  const srcExists = await dirExists(src);
  if (!srcExists) {
    return false;
  }
  const destExists = await dirExists(dest);
  if (destExists) {
    // Already migrated — nothing to do.
    return false;
  }
  try {
    await copyRecursive(src, dest);
    warn(`[nightclaw] Migrated data from ${src} to ${dest}.`);
  } catch (err) {
    warn(`[nightclaw] Could not migrate ${src} → ${dest}: ${String(err)}`);
    return false;
  }
  // Remove the original openclaw directory so the old binary can no longer
  // read or write stale state, and to prevent accidental openclaw restarts.
  try {
    await fs.rm(src, { recursive: true, force: true });
    warn(`[nightclaw] Removed original openclaw directory: ${src}`);
  } catch (err) {
    warn(`[nightclaw] Could not remove ${src}: ${String(err)}`);
  }
  return true;
}

// ─── systemd migration ────────────────────────────────────────────────────────

const OPENCLAW_SYSTEMD_SERVICES = ["openclaw-gateway", "openclaw-node"] as const;

type ServiceState = {
  name: string;
  unitPath: string;
  wasEnabled: boolean;
  wasActive: boolean;
};

async function execSystemctlUser(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", ...args], (err, stdout, stderr) => {
      const rawCode = err?.code;
      const code = typeof rawCode === "number" ? rawCode : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

async function systemctlAvailable(): Promise<boolean> {
  try {
    const res = await execSystemctlUser(["--version"]);
    return res.code === 0;
  } catch {
    return false;
  }
}

/**
 * Inspect, stop, and disable each openclaw systemd service.
 * Returns the pre-migration state for each service that existed.
 */
async function stopOpenclawSystemdServices(warn: (m: string) => void): Promise<ServiceState[]> {
  const home = os.homedir();
  const unitDir = path.join(home, ".config", "systemd", "user");
  const states: ServiceState[] = [];

  for (const name of OPENCLAW_SYSTEMD_SERVICES) {
    const unitPath = path.join(unitDir, `${name}.service`);
    let exists = false;
    try {
      await fs.access(unitPath);
      exists = true;
    } catch {
      // unit file missing
    }

    // Check enabled/active even if unit file is missing (service may have been
    // installed via a different mechanism).
    const enabledRes = await execSystemctlUser(["is-enabled", `${name}.service`]);
    const wasEnabled = enabledRes.code === 0;

    const activeRes = await execSystemctlUser(["is-active", `${name}.service`]);
    const wasActive = activeRes.code === 0;

    if (!exists && !wasEnabled && !wasActive) {
      continue;
    }

    states.push({ name, unitPath, wasEnabled, wasActive });

    try {
      await execSystemctlUser(["disable", "--now", `${name}.service`]);
      warn(`[nightclaw] Stopped and disabled legacy openclaw systemd service: ${name}`);
    } catch (err) {
      warn(`[nightclaw] Could not disable ${name}: ${String(err)}`);
    }

    if (exists) {
      try {
        // Back up the unit file so the user can review it.
        await fs.rename(unitPath, `${unitPath}.openclaw-backup`);
        warn(`[nightclaw] Backed up old unit file to ${unitPath}.openclaw-backup`);
      } catch (err) {
        warn(`[nightclaw] Could not back up ${unitPath}: ${String(err)}`);
      }
    }
  }

  if (states.length > 0) {
    await execSystemctlUser(["daemon-reload"]).catch(() => {
      // Best-effort.
    });
  }

  return states;
}

/**
 * Install nightclaw systemd service units, then re-enable and re-start those
 * services that were originally enabled/active.
 *
 * Requires the nightclaw binary to already be on PATH so the ExecStart lines
 * can use it directly. When the current CLI is already the binary, it uses the
 * current `process.argv[1]` path as a fallback.
 */
async function installNightclawSystemdServices(
  states: ServiceState[],
  warn: (m: string) => void,
): Promise<void> {
  if (states.length === 0) {
    return;
  }

  const home = os.homedir();
  const unitDir = path.join(home, ".config", "systemd", "user");
  await fs.mkdir(unitDir, { recursive: true });

  // Determine the nightclaw binary path.
  const binaryPath = process.argv[1]?.trim() || "nightclaw";

  for (const state of states) {
    // Map openclaw-<kind> → nightclaw-<kind>
    const newName = state.name.replace(/^openclaw-/, "nightclaw-");
    const kind = newName.replace("nightclaw-", ""); // "gateway" or "node"
    const newUnitPath = path.join(unitDir, `${newName}.service`);

    const unit = [
      "[Unit]",
      `Description=NightClaw ${kind.charAt(0).toUpperCase() + kind.slice(1)} (migrated from ${state.name})`,
      "After=network.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${binaryPath} ${kind} --port 18789`,
      "Restart=on-failure",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");

    try {
      await fs.writeFile(newUnitPath, unit, "utf8");
      warn(`[nightclaw] Wrote new systemd unit: ${newUnitPath}`);
    } catch (err) {
      warn(`[nightclaw] Could not write ${newUnitPath}: ${String(err)}`);
      continue;
    }

    await execSystemctlUser(["daemon-reload"]).catch(() => {
      // Best-effort.
    });

    if (state.wasEnabled) {
      const enableRes = await execSystemctlUser(["enable", `${newName}.service`]);
      if (enableRes.code === 0) {
        warn(`[nightclaw] Enabled nightclaw systemd service: ${newName}`);
      } else {
        warn(`[nightclaw] Could not enable ${newName}: ${enableRes.stderr.trim()}`);
      }
    }

    if (state.wasActive) {
      const startRes = await execSystemctlUser(["start", `${newName}.service`]);
      if (startRes.code === 0) {
        warn(`[nightclaw] Started nightclaw systemd service: ${newName}`);
      } else {
        warn(`[nightclaw] Could not start ${newName}: ${startRes.stderr.trim()}`);
      }
    }
  }
}

async function migrateSystemdServices(warn: (m: string) => void): Promise<void> {
  if (!(await systemctlAvailable())) {
    return;
  }
  const states = await stopOpenclawSystemdServices(warn);
  await installNightclawSystemdServices(states, warn);
}

// ─── launchd migration (macOS) ────────────────────────────────────────────────

const OPENCLAW_LAUNCHD_LABELS = ["ai.openclaw.gateway", "ai.openclaw.node"] as const;

async function execLaunchctl(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("launchctl", args, (err, stdout, stderr) => {
      const rawCode = err?.code;
      const code = typeof rawCode === "number" ? rawCode : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

async function migrateLingerServices(warn: (m: string) => void): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const home = os.homedir();
  const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
  const binaryPath = process.argv[1]?.trim() || "nightclaw";

  for (const oldLabel of OPENCLAW_LAUNCHD_LABELS) {
    const oldPlist = path.join(launchAgentsDir, `${oldLabel}.plist`);

    // Check whether the old agent is loaded.
    const domain = `gui/${process.getuid?.() ?? 501}`;
    const printRes = await execLaunchctl(["print", `${domain}/${oldLabel}`]);
    const wasLoaded = printRes.code === 0;

    // Check whether the plist exists on disk.
    let plistExists = false;
    try {
      await fs.access(oldPlist);
      plistExists = true;
    } catch {
      // not present
    }

    if (!wasLoaded && !plistExists) {
      continue;
    }

    // Unload the old agent.
    if (wasLoaded) {
      await execLaunchctl(["bootout", `${domain}/${oldLabel}`]).catch(() => {});
      await execLaunchctl(["unload", oldPlist]).catch(() => {});
      warn(`[nightclaw] Unloaded legacy LaunchAgent: ${oldLabel}`);
    }

    // Move the old plist to Trash.
    if (plistExists) {
      const trashDir = path.join(home, ".Trash");
      try {
        await fs.mkdir(trashDir, { recursive: true });
        await fs.rename(oldPlist, path.join(trashDir, `${oldLabel}.plist`));
        warn(`[nightclaw] Moved legacy plist to Trash: ${oldLabel}.plist`);
      } catch {
        warn(`[nightclaw] Could not move ${oldPlist} to Trash`);
      }
    }

    // Map label → nightclaw equivalent.
    const newLabel = oldLabel.replace("ai.openclaw.", "ai.nightclaw.");
    const kind = newLabel.replace("ai.nightclaw.", ""); // "gateway" or "node"
    const newPlist = path.join(launchAgentsDir, `${newLabel}.plist`);

    // Skip if the new plist is already in place.
    try {
      await fs.access(newPlist);
      if (wasLoaded) {
        // Re-load the existing plist.
        await execLaunchctl(["load", "-w", newPlist]).catch(() => {});
        warn(`[nightclaw] Re-loaded existing LaunchAgent: ${newLabel}`);
      }
      continue;
    } catch {
      // New plist doesn't exist yet; create a minimal one.
    }

    await fs.mkdir(launchAgentsDir, { recursive: true });
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${newLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>${kind}</string>
    <string>--port</string>
    <string>18789</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
    try {
      await fs.writeFile(newPlist, plistContent, "utf8");
      warn(`[nightclaw] Wrote new LaunchAgent plist: ${newPlist}`);
    } catch (err) {
      warn(`[nightclaw] Could not write ${newPlist}: ${String(err)}`);
      continue;
    }

    if (wasLoaded) {
      await execLaunchctl(["load", "-w", newPlist]).catch(() => {});
      warn(`[nightclaw] Loaded new LaunchAgent: ${newLabel}`);
    }
  }
}

// ─── global uninstall ─────────────────────────────────────────────────────────

/**
 * Attempt to uninstall the legacy `openclaw` global package via npm, pnpm, or
 * bun (whichever is available), so the old binary can no longer be accidentally
 * invoked.  This is best-effort: errors are logged as warnings and never fatal.
 */
async function uninstallOpenclawGlobal(warn: (m: string) => void): Promise<void> {
  const { execFile } = await import("node:child_process");
  const runCmd = (cmd: string, args: string[]): Promise<number> =>
    new Promise((resolve) => {
      execFile(cmd, args, (err) => {
        const code = typeof err?.code === "number" ? err.code : 0;
        resolve(code);
      });
    });

  // Try each package manager in turn; stop on the first success.
  const candidates: Array<{ cmd: string; args: string[] }> = [
    { cmd: "npm", args: ["uninstall", "-g", "openclaw"] },
    { cmd: "pnpm", args: ["remove", "-g", "openclaw"] },
    { cmd: "bun", args: ["remove", "-g", "openclaw"] },
  ];

  for (const { cmd, args } of candidates) {
    try {
      const code = await runCmd(cmd, args);
      if (code === 0) {
        warn(`[nightclaw] Uninstalled legacy openclaw global package via ${cmd}.`);
        return;
      }
    } catch {
      // Binary not found or failed — try the next one.
    }
  }
}

// ─── migration sentinel ───────────────────────────────────────────────────────

const MIGRATION_SENTINEL_NAME = ".nightclaw-migrated-from-openclaw";

async function isMigrationDone(home: string): Promise<boolean> {
  const sentinel = path.join(home, MIGRATION_SENTINEL_NAME);
  try {
    await fs.access(sentinel);
    return true;
  } catch {
    return false;
  }
}

async function markMigrationDone(home: string): Promise<void> {
  const sentinel = path.join(home, MIGRATION_SENTINEL_NAME);
  try {
    await fs.writeFile(sentinel, new Date().toISOString(), "utf8");
  } catch {
    // Non-fatal.
  }
}

// ─── public entry point ───────────────────────────────────────────────────────

/**
 * Run the one-time OpenClaw → NightClaw migration, if needed.
 *
 * This is deliberately fire-and-forget: it catches all errors and logs them as
 * warnings so the normal CLI flow is never blocked.
 */
export async function maybeRunOpenclawMigration(
  env: NodeJS.ProcessEnv = process.env,
  warn: (m: string) => void = (m) => console.warn(m),
): Promise<void> {
  const home = resolveHome(env);

  // Fast path: sentinel file says migration was already done.
  if (await isMigrationDone(home)) {
    return;
  }

  // Quick check: is there any openclaw data or service at all?
  const openclawDataDir = path.join(home, ".openclaw");
  const anyOpenclaw = await dirExists(openclawDataDir);
  // We also run service migration even when no data dir exists (openclaw may have
  // been installed differently), so we check services separately below.

  // Track whether any openclaw artifact was found so we can decide whether to
  // attempt the global package uninstall at the end.
  let foundOpenclaw = anyOpenclaw;

  // 1. Directory migration (default profile).
  if (anyOpenclaw) {
    const nightclawDataDir = path.join(home, ".nightclaw");
    await migrateDirectory(openclawDataDir, nightclawDataDir, warn);
  }

  // 2. Migrate any profiled directories (~/.openclaw-<name> → ~/.nightclaw-<name>).
  try {
    const homeDirEntries = await fs.readdir(home, { withFileTypes: true });
    for (const entry of homeDirEntries) {
      if (
        entry.isDirectory() &&
        entry.name.startsWith(".openclaw-") &&
        !entry.name.endsWith(".openclaw-backup")
      ) {
        foundOpenclaw = true;
        const suffix = entry.name.slice(".openclaw-".length);
        const srcProfile = path.join(home, entry.name);
        const destProfile = path.join(home, `.nightclaw-${suffix}`);
        await migrateDirectory(srcProfile, destProfile, warn);
      }
    }
  } catch (err) {
    warn(`[nightclaw] Could not scan home dir for openclaw profiles: ${String(err)}`);
  }

  // 3. systemd service migration (Linux).
  try {
    await migrateSystemdServices(warn);
  } catch (err) {
    warn(`[nightclaw] systemd service migration error: ${String(err)}`);
  }

  // 4. launchd service migration (macOS).
  try {
    await migrateLingerServices(warn);
  } catch (err) {
    warn(`[nightclaw] launchd migration error: ${String(err)}`);
  }

  // 5. Remove the legacy openclaw global package only when we detected openclaw
  //    artifacts, so it can no longer be accidentally triggered while nightclaw
  //    is running.
  if (foundOpenclaw) {
    try {
      await uninstallOpenclawGlobal(warn);
    } catch (err) {
      warn(`[nightclaw] openclaw global uninstall error: ${String(err)}`);
    }
  }

  // Write sentinel so we don't re-run on every invocation.
  await markMigrationDone(home);
}
