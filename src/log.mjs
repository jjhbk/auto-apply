// One JSON line per job the worker looked at: applied, skipped, needs-input, dry-run or error.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const logFile = join(resolve(import.meta.dirname, ".."), "logs", "applications.jsonl");

export function readLog() {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function appendLog(entry) {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n");
}
