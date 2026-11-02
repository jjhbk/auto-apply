// Prints the application log as a table. `npm run log -- applied` shows only one status.
import { readLog, logFile } from "./log.mjs";

const only = process.argv[2];
const rows = readLog().filter((e) => !only || e.status === only);
if (!rows.length) {
  console.log(`No entries yet in ${logFile}`);
} else {
  console.table(rows.map((e) => ({
    when: e.time.slice(0, 16).replace("T", " "),
    mode: e.mode,
    status: e.status,
    job: `${e.title} @ ${e.company}`.slice(0, 60),
    reason: (e.reason ?? "").slice(0, 70),
  })));
  console.log(`Full details: ${logFile}`);
}
