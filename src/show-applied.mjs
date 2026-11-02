// Lists every job in the applied-jobs database (data/applied.json), newest first.
import { appliedJobs, dbFile } from "./applied.mjs";

const jobs = [...appliedJobs()].sort((a, b) => b.at.localeCompare(a.at));
for (const j of jobs) console.log(`${j.at.slice(0, 10)}  ${j.site.padEnd(10)}  ${j.confirmed ? "sent       " : "unconfirmed"}  ${j.company} | ${j.title}`);
console.log(`\n${jobs.length} applications (${jobs.filter((j) => !j.confirmed).length} not confirmed) in ${dbFile}`);
