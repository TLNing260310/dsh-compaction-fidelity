#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const action = (args[0] ?? "status").toLowerCase();
const homeIndex = args.indexOf("--home");
const home = homeIndex >= 0 && args[homeIndex + 1] ? args[homeIndex + 1] : (process.env.DSH_HOME ?? join(homedir(), ".dsh"));
const stateDir = join(home, ".dsh-compaction-fidelity");
const switchFile = join(stateDir, "disabled");
const stateFile = join(stateDir, "state.json");
function readState() {
  if (!existsSync(stateFile)) return {};
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(patch) {
  mkdirSync(stateDir, { recursive: true });
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function status() {
  const fileOff = existsSync(switchFile);
  const state = readState();
  const envOff = ["1", "true", "yes", "on"].includes(String(process.env.DSH_COMPACTION_FIDELITY_DISABLED ?? "").trim().toLowerCase());
  console.log(JSON.stringify({
    home,
    switchFile,
    fileSwitch: fileOff ? "disabled" : "not-present",
    environmentSwitch: envOff ? "disabled" : "not-set",
    runtimeEnabled: state.enabled !== false,
    effectiveEnabled: !fileOff && !envOff && state.enabled !== false,
  }, null, 2));
}

if (action === "disable") {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(switchFile, "dsh-compaction-fidelity master switch off\n", "utf8");
  writeState({ enabled: false });
  console.log(`Compaction-Fidelity master switch OFF. Marker: ${switchFile}. Restart DSH Desktop to unload the plugin; runtime /compaction-fidelity off works immediately without restart.`);
} else if (action === "enable") {
  rmSync(switchFile, { force: true });
  writeState({ enabled: true });
  console.log(`Compaction-Fidelity master switch ON. Marker removed: ${switchFile}. Restart DSH Desktop if it was started with the marker present.`);
} else if (action === "status") {
  status();
} else {
  console.error("Usage: node scripts/master-switch.mjs disable|enable|status [--home <DSH_HOME>]");
  process.exitCode = 2;
}
