// Finds jobs on each site in config.sites (or --site=...) and fills their application forms in a visible browser.
// Every site runs at the same time in its own tab, with its own count and its own wait between applications.
// You sign in to each site yourself; Auto Apply never reads, types or stores your passwords.
//   npm start                 fill each form, then ask you before submitting
//   npm run dry-run           fill each form up to Submit, then discard it (nothing is sent)
//   --site=wellfound,yc only these sites    --limit=N  stop each site after N applications    --auto-submit  don't ask
import { fileURLToPath } from "node:url";
import { arg, args, config, dryRun, mode, say, sleep, pause, openBrowser, filterReason, pickResume, appendLog, closeAsk, siteContext } from "./core.mjs";
import { find, recordSent } from "./applied.mjs";
import { readLog } from "./log.mjs";
import { loadSites } from "./sites/index.mjs";

const retry = args.includes("--retry");
const maxApplications = arg("limit") ? Number(arg("limit")) : config.apply.maxApplicationsPerRun;
const seen = new Set();
let stopped = false;

// One site's whole run, in its own tab. Returns how many applications it handled.
async function runSite(site, page) {
  let handled = 0;
  if (site.signIn) await site.signIn(page);
  for await (const found of site.findJobs(page)) {
    if (stopped || handled >= maxApplications) break;
    if (seen.has(found.id)) continue;
    seen.add(found.id);
    // A job that stopped on questions Auto Apply can't answer stops again the same way; skip it unless --retry.
    const stuck = !retry && readLog().findLast((e) => e.jobId === found.id && e.mode === "live" && e.status !== "skipped");
    if (stuck?.status === "needs-input" && /^questions without an answer/.test(stuck.reason ?? "")) { say(`Skip ${found.id}: needs your input from ${stuck.time.slice(0, 10)} (${stuck.reason.slice(0, 90)}); --retry tries it again.`); continue; }
    const before = find({ jobId: found.id, url: found.url });
    if (before) { say(`Skip ${found.id}: applied on ${before.at.slice(0, 10)}${before.confirmed ? "" : " (submitted, not confirmed)"}.`); continue; }
    const job = { site: site.id, ...found, ...(found.load ? await found.load() : {}) };
    delete job.load;
    const base = { mode, site: site.id, search: job.search, jobId: job.id, title: job.title, company: job.company, url: job.url };
    // Checked again here: another site may have just applied to the same job.
    const reason = filterReason(job);
    if (reason) {
      appendLog({ ...base, status: "skipped", reason });
      say(`Skip: ${job.title} at ${job.company} (${reason})`);
      continue;
    }
    const resume = pickResume(job.title);
    say(`Applying: ${job.title} at ${job.company} with the ${resume.name} resume`);
    const state = { step: 0, resumeUploaded: false, drafted: [], job };
    let result;
    try {
      result = await site.apply(page, job, resume, state);
    } catch (err) {
      result = { status: "error", reason: err.message.split("\n")[0] };
    }
    appendLog({ ...base, resume: resume.file, status: result.status, reason: result.reason, drafted: state.drafted, screenshot: result.screenshot, formText: result.formText });
    if (!dryRun && (result.status === "applied" || result.submitted)) recordSent({ ...base, status: result.status });
    say(`  -> ${result.status}: ${result.reason}`);
    const sent = result.status === "applied" || result.submitted;
    if (result.status === (dryRun ? "dry-run" : "applied") || result.submitted) handled++;
    if (result.quit) { stopped = true; break; }
    // After a real send, this site waits a few minutes before its next one; the other sites carry on.
    const [lo, hi] = config.apply.minutesBetweenApplications ?? [0, 0];
    if (sent && hi > 0 && handled < maxApplications) {
      const minutes = lo + Math.random() * (hi - lo);
      say(`  Next application here in about ${Math.round(minutes)} minutes (${new Date(Date.now() + minutes * 60_000).toLocaleTimeString()}).`);
      const until = Date.now() + minutes * 60_000;
      while (!stopped && Date.now() < until) await sleep(Math.min(5000, until - Date.now()));
    } else {
      await pause(config.apply.secondsBetweenJobs);
    }
  }
  return handled;
}

async function main() {
  const sites = await loadSites(arg("site")?.split(",") ?? config.sites ?? ["wellfound"]);
  say(`Mode: ${mode}${dryRun ? " (nothing will be submitted)" : config.apply.pauseForApproval ? " (you approve each submit)" : " (submits automatically)"}`);
  say(`Sites, each in its own tab at the same time: ${sites.map((s) => s.name).join(", ")}`);
  say(`Up to ${maxApplications} per site this run.`);
  const { context, page: first } = await openBrowser();
  process.on("SIGINT", async () => { say("Stopping."); await context.close().catch(() => {}); process.exit(130); });

  const pages = [first];
  while (pages.length < sites.length) pages.push(await context.newPage());
  const counts = await Promise.all(sites.map((site, i) => siteContext.run({ tag: site.id, page: pages[i] }, async () => {
    try {
      const n = await runSite(site, pages[i]);
      say(`Finished: ${n} ${dryRun ? "form(s) filled to Submit" : "application(s) sent"}.`);
      return n;
    } catch (err) {
      if (/has been closed/.test(err.message)) throw err;
      say(`Stopped this site: ${err.message.split("\n")[0]}`);
      return 0;
    }
  })));
  const total = counts.reduce((a, b) => a + b, 0);
  say(`Done. ${sites.map((s, i) => `${s.name} ${counts[i]}`).join(", ")}; ${total} in all. See the log with: npm run log`);
  closeAsk();
  await context.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((err) => {
  if (/has been closed/.test(err.message)) { say("The browser window was closed, so the run stopped."); process.exit(1); }
  console.error(err);
  process.exit(1);
});
