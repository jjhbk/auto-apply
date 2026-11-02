// LinkedIn: search with LinkedIn's filters, then fill Easy Apply forms.
import { config, sleep, say, mode, screensDir, MONTHS, typeAndPick, fillForm, capture, approve, askForHelp, waitForSignIn } from "../core.mjs";
import { join } from "node:path";

export const name = "LinkedIn";
export const id = "linkedin";

const signedInUrl = /linkedin\.com\/(feed|jobs|mynetwork|messaging|notifications|in\/)/;
export const signIn = (page) => waitForSignIn(page, { name, url: "https://www.linkedin.com/feed/", isSignedIn: async (p) => signedInUrl.test(p.url()) });

const TIME = { day: "r86400", week: "r604800", month: "r2592000" };
const WORKPLACE = { onsite: 1, remote: 2, hybrid: 3 };
const LEVEL = { internship: 1, entry: 2, associate: 3, "mid-senior": 4, director: 5, executive: 6 };

function searchUrl(role, location) {
  const s = config.search;
  // Quoted, so LinkedIn matches the role as a phrase instead of any job mentioning one of its words.
  const q = new URLSearchParams({ keywords: `"${role}"`, location, sortBy: "DD" });
  if (s.easyApplyOnly) q.set("f_AL", "true");
  if (TIME[s.postedWithin]) q.set("f_TPR", TIME[s.postedWithin]);
  if (s.workplace?.length) q.set("f_WT", s.workplace.map((w) => WORKPLACE[w]).filter(Boolean).join(","));
  if (s.experienceLevels?.length) q.set("f_E", s.experienceLevels.map((l) => LEVEL[l]).filter(Boolean).join(","));
  return `https://www.linkedin.com/jobs/search/?${q}`;
}

async function collectJobIds(page, url, max) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-occludable-job-id], [data-job-id]", { timeout: 20_000 }).catch(() => {});
  let ids = [];
  for (let i = 0; i < 8 && ids.length < max; i++) {
    ids = await page.evaluate(() => {
      const els = document.querySelectorAll("[data-occludable-job-id], [data-job-id]");
      const out = new Set();
      for (const el of els) {
        const id = el.getAttribute("data-occludable-job-id") || el.getAttribute("data-job-id");
        if (/^\d+$/.test(id ?? "")) out.add(id);
      }
      // The results list only renders cards as they scroll into view.
      let pane = els[els.length - 1]?.parentElement;
      while (pane && pane.scrollHeight <= pane.clientHeight + 5) pane = pane.parentElement;
      pane?.scrollBy(0, 1200);
      return [...out];
    });
    await sleep(800);
  }
  return ids.slice(0, max);
}

async function readJob(page, id) {
  await page.goto(`https://www.linkedin.com/jobs/view/${id}/`, { waitUntil: "domcontentloaded" });
  await sleep(3000);
  return page.evaluate(() => {
    const text = (el) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    // LinkedIn's page title is "Job title | Company | LinkedIn"; the markup has no stable headings or class names.
    const parts = document.title.replace(/^\(\d+\)\s*/, "").split(" | ");
    const companyLink = [...document.querySelectorAll('main a[href*="/company/"]')].find((a) => text(a));
    const body = (document.querySelector("main") ?? document.body).innerText;
    return {
      title: parts.length >= 3 ? parts.slice(0, -2).join(" | ") : text(document.querySelector("h1")),
      company: parts.length >= 3 ? parts.at(-2) : text(companyLink),
      description: body.slice(body.indexOf("About the job"), body.indexOf("About the job") + 4000),
      alreadyApplied: /\bApplied \d+ \w+ ago\b|Application submitted/i.test(body.slice(0, 6000)),
      noLongerAccepting: /No longer accepting applications/i.test(body.slice(0, 6000)),
    };
  });
}

// LinkedIn search results, one job at a time. Auto Apply opens each job page to read its title and company.
export async function* findJobs(page) {
  for (const role of config.search.roles) {
    for (const location of config.search.locations) {
      say(`LinkedIn: searching "${role}" in ${location}`);
      const ids = await collectJobIds(page, searchUrl(role, location), config.search.maxJobsPerSearch);
      say(`Found ${ids.length} jobs.`);
      for (const id of ids) {
        yield { id, url: `https://www.linkedin.com/jobs/view/${id}/`, search: `${role} @ ${location}`, load: () => readJob(page, id) };
      }
    }
  }
}

// LinkedIn's "Work experience" page lists the jobs on your LinkedIn profile and wants dates for each.
// Fill each one from config.experience (your resume's dates), matched by company name.
async function fillExperience(page, dialog, state) {
  if (state.experienceDone || !/Dates of employment/.test(await dialog.innerText().catch(() => ""))) return [];
  const missing = [];
  const edits = dialog.getByRole("button", { name: /^edit, work experience/i });
  const save = dialog.getByRole("button", { name: /^save$/i });
  const alreadyOpen = await save.isVisible().catch(() => false);
  const count = alreadyOpen ? 1 : await edits.count();
  for (let i = 0; i < count; i++) {
    if (!alreadyOpen) await edits.nth(i).click();
    await save.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    await sleep(800);
    const company = await dialog.getByLabel("Company", { exact: true }).inputValue().catch(() => "");
    const job = config.experience?.find((e) => company.toLowerCase().includes(e.company.toLowerCase()) || e.company.toLowerCase().includes(company.toLowerCase().trim() || "\u0000"));
    const selects = dialog.locator("select");
    const [fromMonth, fromYear] = [selects.nth(0), selects.nth(1)];
    const hasStart = !/^month$/i.test(await fromMonth.evaluate((s) => s.selectedOptions[0]?.textContent.trim()).catch(() => "Month"));
    if (!job) {
      if (!hasStart) missing.push(`work experience dates for "${company || "an entry"}"`);
      else await save.click();
      await sleep(1500);
      continue;
    }
    const [fy, fm] = job.from.split("-").map(Number);
    await fromMonth.selectOption({ label: MONTHS[fm - 1] });
    await fromYear.selectOption({ label: String(fy) });
    const current = dialog.getByRole("checkbox", { name: /currently work here/i }).or(dialog.locator('input[type="checkbox"]').first()).first();
    const isCurrent = job.to === "present";
    if ((await current.isChecked().catch(() => false)) !== isCurrent) await dialog.getByText(/I currently work here/i).click();
    await sleep(500);
    if (!isCurrent) {
      const [ty, tm] = job.to.split("-").map(Number);
      await selects.nth(2).selectOption({ label: MONTHS[tm - 1] });
      await selects.nth(3).selectOption({ label: String(ty) });
    }
    const city = dialog.getByLabel("City", { exact: true });
    if (job.city && (await city.isVisible().catch(() => false)) && !(await city.inputValue())) await typeAndPick(page, city, job.city);
    await save.click();
    await sleep(2000);
    if (await save.isVisible().catch(() => false)) missing.push(`LinkedIn did not accept the dates for "${company}"`);
  }
  if (!missing.length) state.experienceDone = true;
  return missing;
}

// Same idea for the "Education" page, from config.education.
async function fillEducation(page, dialog, state) {
  if (state.educationDone || !/Dates attended/.test(await dialog.innerText().catch(() => ""))) return [];
  const missing = [];
  const edits = dialog.getByRole("button", { name: /^edit, education/i });
  const save = dialog.getByRole("button", { name: /^save$/i });
  const alreadyOpen = await save.isVisible().catch(() => false);
  const count = alreadyOpen ? 1 : await edits.count();
  for (let i = 0; i < count; i++) {
    if (!alreadyOpen) await edits.nth(i).click();
    await save.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    await sleep(800);
    const school = dialog.getByLabel("School", { exact: true });
    const current = await school.inputValue().catch(() => "");
    const edu = config.education?.find((e) => !current || e.school.toLowerCase().includes(current.toLowerCase()) || current.toLowerCase().includes("roorkee"));
    if (!edu) { missing.push(`education details for "${current}"`); continue; }
    if (!current) await typeAndPick(page, school, edu.school);
    for (const [label, value] of [["City", edu.city], ["Degree", edu.degree], ["Major / Field of study", edu.field]]) {
      const el = dialog.getByLabel(label, { exact: true });
      if (value && (await el.isVisible().catch(() => false))) await el.fill(value);
    }
    const selects = dialog.locator("select");
    for (const [i, date] of [[0, edu.from], [2, edu.to]]) {
      if (!date) continue;
      const [y, m] = date.split("-").map(Number);
      await selects.nth(i).selectOption({ label: MONTHS[m - 1] }).catch(() => {});
      await selects.nth(i + 1).selectOption({ label: String(y) }).catch(() => {});
    }
    await save.click();
    await sleep(2000);
    if (await save.isVisible().catch(() => false)) missing.push("LinkedIn did not accept the education details");
  }
  if (!missing.length) state.educationDone = true;
  return missing;
}

async function discard(page, dialog) {
  const close = dialog.getByRole("button", { name: /dismiss|close/i }).first();
  if (await close.isVisible().catch(() => false)) await close.click();
  else await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^discard$/i }).click({ timeout: 4000 }).catch(() => {});
  await sleep(1000);
}

export async function apply(page, job, resume, state) {
  // Only the job's own button: "More jobs" cards below also contain the words "Easy Apply".
  const button = page.getByRole("button", { name: /easy apply/i }).or(page.locator('a[aria-label*="Easy Apply" i]')).first();
  if (!(await button.isVisible().catch(() => false))) return { status: "skipped", reason: "applies on the company's own site, not Easy Apply" };
  await button.click();
  const dialog = page.getByRole("dialog").filter({ hasText: /apply to/i }).last();
  await dialog.waitFor({ timeout: 15_000 });
  let lastProgress = "";

  // Each step loads behind a spinner; wait until it shows a way forward before reading it.
  const actions = dialog.getByRole("button", { name: /submit application|review|next|continue/i }).first();
  for (let step = 0; step < 15; step++) {
    await actions.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    await sleep(1000);
    const entries = [...(await fillExperience(page, dialog, state)), ...(await fillEducation(page, dialog, state))];
    const missing = entries.length ? entries : await fillForm(page, dialog, resume, state, { localPhone: true });
    const submit = dialog.getByRole("button", { name: /submit application/i });

    if (await submit.isVisible().catch(() => false)) {
      const shot = join(screensDir, `${job.id}-${mode}.png`);
      await page.screenshot({ path: shot });
      const decision = await approve(job, resume, state);
      if (decision !== "submit") {
        await discard(page, dialog);
        if (decision === "dry-run") return { status: "dry-run", reason: "form filled up to Submit, then discarded; nothing was sent", screenshot: shot };
        return { status: "skipped", reason: decision === "quit" ? "you stopped the run" : "you chose not to submit", quit: decision === "quit" };
      }
      await submit.click();
      // Only count it as applied once LinkedIn confirms the application went out.
      const sent = await page.getByText(/your application was sent|application submitted|you applied/i).first()
        .waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);
      const sentShot = join(screensDir, `${job.id}-${mode}-sent.png`);
      await page.screenshot({ path: sentShot }).catch(() => {});
      await page.getByRole("button", { name: /dismiss|done|close/i }).first().click().catch(() => {});
      if (!sent) return { status: "error", reason: "clicked Submit but LinkedIn showed no confirmation; check the job page", screenshot: sentShot, submitted: true };
      return { status: "applied", reason: config.apply.pauseForApproval ? "you approved it" : "submitted automatically", screenshot: sentShot };
    }

    const progress = (await dialog.innerText().catch(() => "")).slice(0, 400);
    const stuck = progress === lastProgress;
    lastProgress = progress;
    if (missing.length || stuck) {
      const what = missing.length ? missing.join(" | ") : "LinkedIn did not accept this step";
      const help = await askForHelp(what);
      if (help !== "continue") {
        const seen = await capture(page, dialog, job, "needs-input");
        await discard(page, dialog);
        return help === "skip" ? { status: "skipped", reason: `you skipped it at: ${what}` } : { status: "needs-input", reason: `questions without an answer: ${what}`, ...seen };
      }
      lastProgress = "";
      continue;
    }

    const next = dialog.getByRole("button", { name: /review|next|continue/i }).first();
    if (!(await next.isVisible().catch(() => false))) {
      const seen = await capture(page, dialog, job, "no-next");
      await discard(page, dialog);
      return { status: "error", reason: "could not find the Next button", ...seen };
    }
    await next.click();
  }
  await discard(page, dialog);
  return { status: "error", reason: "the form had more steps than expected" };
}

