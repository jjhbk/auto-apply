// A small local database of every job Auto Apply has sent an application to: data/applied.json.
// Auto Apply checks it before each job and never applies twice to the same posting, the same link,
// or the same role at the same company found on another site. Submits that weren't confirmed count too.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readLog } from "./log.mjs";

export const dbFile = join(resolve(import.meta.dirname, ".."), "data", "applied.json");

const norm = (t) => (t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// "Rubrik Job Board", "HackerRank Careers" and "Searce Inc" are the same companies as "Rubrik", "HackerRank" and "Searce".
const companyKey = (c) => norm(c).replace(/\b(job board|careers?|jobs|inc|llc|ltd|limited|pvt|private|corp(oration)?|co)\b/g, " ").replace(/\s+/g, " ").trim();
// "Sr AI Engineer" and "Senior AI Engineer" are the same role reposted.
const titleKey = (t) => norm(t).replace(/\bsr\b/g, "senior").replace(/\bjr\b/g, "junior").replace(/\bengr?\b/g, "engineer");
const roleKey = (company, title) => `${companyKey(company)}|${titleKey(title)}`;
// The same job's link with tracking bits removed (Greenhouse keeps the job in gh_jid).
function urlKey(url) {
  try {
    const u = new URL(url);
    const gh = u.searchParams.get("gh_jid") ?? u.searchParams.get("token");
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/(application)?$/, "")}${gh ? `?${gh}` : ""}`;
  } catch {
    return "";
  }
}

// A log entry that means an application went out: confirmed, or Submit clicked without seeing the confirmation.
const wasSent = (e) => e.mode === "live" && (e.status === "applied"
  || (e.status === "error" && /clicked (submit|send)/i.test(e.reason ?? "")));

let db;
function load() {
  if (db) return db;
  if (existsSync(dbFile)) {
    db = JSON.parse(readFileSync(dbFile, "utf8"));
  } else {
    // First use: fill it from everything already in the log.
    db = { jobs: [] };
    for (const e of readLog().filter(wasSent)) add(e, false);
    save();
  }
  return db;
}

function save() {
  mkdirSync(dirname(dbFile), { recursive: true });
  writeFileSync(`${dbFile}.tmp`, JSON.stringify(db, null, 2) + "\n");
  renameSync(`${dbFile}.tmp`, dbFile);
}

function add(e, persist = true) {
  if (find(e)) return;
  db.jobs.push({
    jobId: e.jobId, url: e.url, site: e.site ?? "linkedin", company: e.company, title: e.title,
    confirmed: e.status === "applied", at: e.time ?? new Date().toISOString(),
  });
  if (persist) save();
}

// The earlier application this job repeats, if any.
export function find({ jobId, id, url, company, title }) {
  const jobs = (db ?? load()).jobs;
  jobId ??= id;
  const u = url && urlKey(url);
  const r = company && title && roleKey(company, title);
  return jobs.find((j) => (jobId && j.jobId === jobId) || (u && urlKey(j.url) === u) || (r && roleKey(j.company, j.title) === r));
}

// Call after every real submit, confirmed or not.
export function recordSent(entry) {
  load();
  add(entry);
}

export const appliedJobs = () => load().jobs;

// How many applications went to this company in the last `days` days.
export function sentToCompany(company, days) {
  const since = Date.now() - days * 86_400_000;
  return load().jobs.filter((j) => companyKey(j.company) === companyKey(company) && Date.parse(j.at) >= since).length;
}

