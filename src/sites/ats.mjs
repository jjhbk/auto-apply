// Shared code for company job boards hosted on Greenhouse, Lever and Ashby.
// Jobs come from each company's public job feed (no sign-in); the application form is filled in the browser.
import { join } from "node:path";
import { config, mode, say, sleep, screensDir, fillForm, capture, approve, showTab } from "../core.mjs";

// Where a job must be for Auto Apply to apply. Plain "Remote" usually means remote in the company's home country,
// so it only counts when config.siteSearch.atsAcceptAnyRemote is true.
const PLACES = /india|bengaluru|bangalore|hyderabad|apac|asia|anywhere|worldwide|global/i;
export function locationOk(location) {
  const extra = config.siteSearch?.atsLocations ? new RegExp(config.siteSearch.atsLocations, "i") : null;
  if (PLACES.test(location) || extra?.test(location)) return true;
  // "Remote" only counts on its own: "Paris, France, Remote" is a Paris job.
  const elsewhere = location.replace(/remote|hybrid|[(),/|;•·-]/gi, " ").trim();
  return !!config.siteSearch?.atsAcceptAnyRemote && /remote/i.test(location) && !elsewhere;
}

// A US job: "San Francisco, CA", "Seattle, WA, US", "Remote - United States". (", IN" is Indiana here only when nothing Indian is named.)
const US_STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
export function usLocation(location = "") {
  if (/india|bengaluru|bangalore|hyderabad|, ?IN\b/i.test(location) && !/united states|\bUSA?\b/.test(location)) return false;
  return /united states|\bUSA?\b|san francisco|bay area|new york|seattle|boston|austin|chicago|los angeles|palo alto|mountain view/i.test(location)
    || new RegExp(`, ?(${US_STATES})\\b`).test(location);
}

export async function getJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "auto-apply" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

export const htmlToText = (html = "") => html.replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();

// Runs list(company) for every company in config.ats[atsId] and yields the jobs in the right place.
export async function* companyJobs(atsId, list) {
  for (const company of config.ats?.[atsId] ?? []) {
    let jobs;
    try {
      jobs = await list(company);
    } catch (err) {
      say(`  ${company}: couldn't read the job feed (${err.message})`);
      continue;
    }
    const near = jobs.filter((j) => locationOk(j.location));
    say(`${atsId}: ${company} has ${jobs.length} jobs, ${near.length} in your locations`);
    for (const j of near) yield { ...j, search: `${atsId}:${company}` };
  }
}

// Fills a one-page application form at job.applyUrl, then submits after approval.
// site: { submit: RegExp for the submit button, sent: RegExp for the confirmation text, form: CSS for the form root }.
export async function applyOnForm(page, job, resume, state, site) {
  await page.goto(job.applyUrl, { waitUntil: "domcontentloaded" });
  await sleep(4000);
  if (/page not found|job (is )?no longer (available|open)|this job has (been )?closed|position (has been )?filled/i.test(await page.locator("body").innerText().catch(() => ""))) {
    return { status: "skipped", reason: "the listing is closed or its page is gone (the job feed still lists it)" };
  }
  const submit = page.getByRole("button", { name: site.submit }).first();
  if (!(await submit.isVisible({ timeout: 15_000 }).catch(() => false)) && !(await submit.waitFor({ timeout: 10_000 }).then(() => true, () => false))) {
    const seen = await capture(page, page.locator("body"), job, "no-form");
    return { status: "error", reason: "couldn't find the application form", ...seen };
  }
  const form = page.locator(site.form ?? "form").filter({ has: submit }).first();
  const root = (await form.count()) ? form : page.locator("body");
  // Some fields (custom questions, "Upload resume") appear only after earlier ones load; two passes catch them.
  let missing = await fillForm(page, root, resume, state, { resumeButton: /^(upload|attach)( (resume|cv|file))?$/i });
  await sleep(1500);
  missing = await fillForm(page, root, resume, state, { resumeButton: /^(upload|attach)( (resume|cv|file))?$/i });
  // Forms sometimes drop the uploaded file while rebuilding; attach it again if its name isn't showing.
  const fileName = resume.path.split("/").pop();
  if (!(await page.getByText(fileName).first().isVisible().catch(() => false))) {
    const input = page.locator('input[type="file"][id*="resume" i], input[type="file"][name*="resume" i], input[type="file"]').first();
    if (await input.count()) {
      say("  re-attaching the resume");
      await input.setInputFiles(resume.path).catch(() => {});
      await sleep(4000);
    }
  }
  if (missing.length) {
    const seen = await capture(page, root, job, "needs-input");
    return { status: "needs-input", reason: `questions without an answer: ${missing.join(" | ")}`, ...seen };
  }
  const shot = join(screensDir, `${job.id.replace(/[^\w.-]/g, "_")}-${mode}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => page.screenshot({ path: shot }));
  const decision = await approve(job, resume, state);
  if (decision === "dry-run") return { status: "dry-run", reason: "form filled; not submitted", screenshot: shot };
  if (decision !== "submit") return { status: "skipped", reason: decision === "quit" ? "you stopped the run" : "you chose not to submit", quit: decision === "quit" };

  await submit.click();
  // A CAPTCHA may appear. Auto Apply never solves it: it waits for you to, in the browser window.
  const sentText = page.getByText(site.sent).first();
  let sent = await sentText.waitFor({ state: "visible", timeout: 20_000 }).then(() => true, () => false);
  // Greenhouse may email a verification code; keep the application out of the applied database
  // until the user enters it and the site confirms the application.
  const codePrompt = page.getByText(/verification code|enter (the )?(email )?(verification )?code|code (was|has been) sent/i).first();
  const codeAsked = await codePrompt.isVisible().catch(() => false);
  const challenged = !sent && (codeAsked || (await page.locator('iframe[src*="captcha"], iframe[title*="captcha" i], .h-captcha, .g-recaptcha').first().isVisible().catch(() => false)));
  if (challenged) {
    await showTab();
    say(codeAsked
      ? "  The site emailed you a verification code. Type it into the form in the browser window and press Submit; I'll wait up to 10 minutes."
      : "  The site is showing a CAPTCHA, and may then email you a code. Please finish both in the browser window; I'll wait up to 10 minutes.");
    sent = await sentText.waitFor({ state: "visible", timeout: 10 * 60_000 }).then(() => true, () => false);
  }
  const sentShot = join(screensDir, `${job.id.replace(/[^\w.-]/g, "_")}-${mode}-sent.png`);
  await page.screenshot({ path: sentShot }).catch(() => {});
  // The form refused it ("Your form needs corrections", "This field is required"): nothing was sent.
  const refused = !sent && await page.getByText(/needs corrections|missing entry for required|this field is required|is required\b|please (fill|complete|correct)/i).first().isVisible().catch(() => false);
  if (refused) {
    const errors = (await page.getByText(/missing entry for required field: .*|.* is required/i).allInnerTexts().catch(() => [])).join(" | ");
    return { status: "needs-input", reason: `the form wasn't accepted (nothing sent): ${errors.slice(0, 300) || "required fields missing"}`, screenshot: sentShot };
  }
  const codeStillNeeded = !sent && (codeAsked || await codePrompt.isVisible().catch(() => false));
  if (codeStillNeeded) return {
    status: "needs-code",
    reason: "Greenhouse is waiting for your email verification code; no application confirmation was seen, so this job was not added to the applied database",
    screenshot: sentShot,
  };
  // An unsolved CAPTCHA means the site never took the application.
  if (!sent && challenged) return { status: "needs-input", reason: "not sent: the CAPTCHA wasn't completed in time", screenshot: sentShot };
  if (!sent) return { status: "error", reason: "clicked Submit but saw no confirmation; check the screenshot", screenshot: sentShot, submitted: true };
  return { status: "applied", reason: config.apply.pauseForApproval ? "you approved it" : "submitted automatically", screenshot: sentShot };
}
