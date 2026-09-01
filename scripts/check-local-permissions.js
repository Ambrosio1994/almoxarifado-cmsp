import { chmod, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

export function localPermissionTargets(root = ROOT) {
  return [
    { path: join(root, ".env"), mode: 0o600, kind: "file" },
    { path: join(root, ".env.production"), mode: 0o600, kind: "file" },
    { path: join(root, "data"), mode: 0o700, kind: "directory" },
    { path: join(root, "data", "store.json"), mode: 0o600, kind: "file" }
  ];
}

export async function checkLocalPermissions(options = {}) {
  const apply = options.apply === true;
  if (process.platform === "win32") {
    return { supported: false, applied: false, compliant: true, entries: [] };
  }
  const entries = [];
  for (const target of localPermissionTargets(options.root || ROOT)) {
    try {
      const metadata = await lstat(target.path);
      if (metadata.isSymbolicLink() || (target.kind === "file" && !metadata.isFile()) || (target.kind === "directory" && !metadata.isDirectory())) {
        entries.push({ path: target.path, expectedMode: modeText(target.mode), status: "unsafe-type" });
        continue;
      }
      const actualMode = metadata.mode & 0o777;
      if (actualMode !== target.mode && apply) await chmod(target.path, target.mode);
      entries.push({
        path: target.path,
        expectedMode: modeText(target.mode),
        actualMode: modeText(actualMode),
        status: actualMode === target.mode ? "ok" : (apply ? "corrected" : "needs-correction")
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        entries.push({ path: target.path, expectedMode: modeText(target.mode), status: "absent" });
        continue;
      }
      entries.push({ path: target.path, expectedMode: modeText(target.mode), status: "error", code: error?.code || "UNKNOWN" });
    }
  }
  return {
    supported: true,
    applied: apply,
    compliant: entries.every((entry) => ["ok", "corrected", "absent"].includes(entry.status)),
    entries
  };
}

function modeText(mode) {
  return `0${mode.toString(8)}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await checkLocalPermissions({ apply: process.argv.includes("--apply") });
  console.log(JSON.stringify(result));
  if (!result.compliant) process.exitCode = 1;
}
