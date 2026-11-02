// Wellfound (formerly AngelList Talent): startup jobs, one profile, apply with a short note to the company.
import { join } from "node:path";
import { config, mode, say, sleep, screensDir, waitForSignIn, fillForm, capture, approve } from "../core.mjs";

export const name = "Wellfound";
export const id = "wellfound";

// Signed in when the page has no "Log in" link and isn't the login page.
const isSignedIn = async (page) => !/\/login|\/join/.test(page.url())
  && !(await page.getByRole("link", { name: /^log ?in$/i }).first().isVisible().catch(() => false));
export const signIn = (page) => waitForSignIn(page, { name, url: "https://wellfound.com/jobs", isSignedIn });

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Role pages (/role/l/ai-engineer/bangalore) where Wellfound has them, and keyword search for everything else.
// Wellfound redirects a role it doesn't know to a generic page, so those are dropped.
function searches() {
  const custom = config.siteSearch?.wellfound;
  if (custom?.length) return custom.map((url) => ({ url, label: url, expect: null }));
  const places = config.siteSearch?.wellfoundLocations ?? ["bangalore", "india"];
  return config.search.roles.flatMap((role) => [
    ...places.map((p) => ({ url: `https://wellfound.com/role/l/${slug(role)}/${p}`, label: `${role} @ ${p}`, expect: slug(role) })),
    { url: `https://wellfound.com/jobs?query=${encodeURIComponent(role)}`, label: `${role} (search)`, expect: "query=" },
  ]);
}

async function jobLinks(page) {
  return page.evaluate(() => {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/jobs/"]')) {
      const m = a.getAttribute("href")?.match(/\/jobs\/(\d+)[\w-]*/);
      if (m) seen.add(m[0]);
    }
    return [...seen];
  });
}

async function readJob(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await sleep(4000);
  return page.evaluate(() => {
    // The page title is "Job title at Company • Location | Wellfound".
    const head = document.title.replace(/\s*\|\s*Wellfound\s*$/, "").split(" • ")[0];
    const at = head.lastIndexOf(" at ");
    const main = (document.querySelector("main") ?? document.body).innerText;
    return {
      title: at > 0 ? head.slice(0, at) : head,
      company: at > 0 ? head.slice(at + 4) : "",
      description: main.slice(0, 5000),
      noLongerAccepting: /no longer accepting|this job is closed/i.test(main),
      external: /apply on (the )?company('s)? website/i.test(main) && !/apply on wellfound/i.test(main),
    };
  });
}

export async function* findJobs(page) {
  const max = config.search.maxJobsPerSearch;
  for (const s of searches()) {
    say(`Wellfound: ${s.label}`);
    await page.goto(s.url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(6000);
    if (s.expect && !page.url().includes(s.expect)) { say("  no such role page on Wellfound; skipping"); continue; }
    let links = await jobLinks(page);
    // Results load as you scroll.
    for (let i = 0; i < 6 && links.length < max; i++) {
      await page.mouse.wheel(0, 3000);
      await sleep(1500);
      links = await jobLinks(page);
    }
    say(`Found ${links.length} jobs.`);
    for (const path of links.slice(0, max)) {
      const url = `https://wellfound.com${path}`;
      yield { id: `wellfound:${path.match(/\d+/)[0]}`, url, search: s.label, load: () => readJob(page, url) };
    }
  }
}

export async function apply(page, job, resume, state) {
  if (job.external) return { status: "skipped", reason: "applies on the company's own website" };
  const applyButton = page.getByRole("button", { name: /^apply( now)?$/i }).first();
  if (!(await applyButton.isVisible().catch(() => false))) {
    return { status: "skipped", reason: /applied/i.test(await page.locator("main").innerText().catch(() => "")) ? "already applied on Wellfound" : "no Apply button on the job page" };
  }
  const clicked = await applyButton.click({ timeout: 15_000 }).then(() => true, () => false);
  if (!clicked) {
    const seen = await capture(page, page.locator("body"), job, "apply-blocked");
    return { status: "error", reason: `couldn't click Apply (something covers it): ${seen.formText.slice(0, 160)}`, ...seen };
  }
  const send = page.getByRole("button", { name: /send application/i });
  await send.waitFor({ state: "visible", timeout: 15_000 });
  // The application panel: the innermost block holding both the questions and the Send button.
  const panel = page.locator("div:has(textarea, input[type=text]):has(button:text-matches('send application', 'i'))").last();
  await sleep(1000);
  const missing = await fillForm(page, panel, resume, state);
  const cancel = page.getByRole("button", { name: /^cancel$/i }).first();
  if (missing.length) {
    const seen = await capture(page, panel, job, "needs-input");
    await cancel.click().catch(() => {});
    return { status: "needs-input", reason: `questions without an answer: ${missing.join(" | ")}`, ...seen };
  }
  const shot = join(screensDir, `${job.id.replace(":", "_")}-${mode}.png`);
  await page.screenshot({ path: shot });
  const decision = await approve(job, resume, state);
  if (decision !== "submit") {
    await cancel.click().catch(() => {});
    if (decision === "dry-run") return { status: "dry-run", reason: "note written and form filled, then cancelled; nothing was sent", screenshot: shot };
    return { status: "skipped", reason: decision === "quit" ? "you stopped the run" : "you chose not to submit", quit: decision === "quit" };
  }
  await send.click();
  // Sent once the panel closes and the job's own button turns into "Applied" (the side menu always has an "Applied" link).
  const closed = await send.waitFor({ state: "hidden", timeout: 15_000 }).then(() => true, () => false);
  await sleep(2000);
  // Wellfound now shows "Success! Your application has been sent." in a follow-up panel; that alone counts.
  const sent = await page.getByText(/application (has been |was )?sent|application submitted/i).first().isVisible().catch(() => false)
    || (closed && await page.getByRole("button", { name: /^applied$/i }).first().isVisible().catch(() => false));
  // Close that panel (it offers an optional AI interview) so the next job starts clean.
  if (sent) await page.keyboard.press("Escape").catch(() => {});
  const sentShot = join(screensDir, `${job.id.replace(":", "_")}-${mode}-sent.png`);
  await page.screenshot({ path: sentShot }).catch(() => {});
  if (!sent) return { status: "error", reason: "clicked Send but Wellfound showed no confirmation; check Applied on Wellfound", screenshot: sentShot, submitted: true };
  return { status: "applied", reason: config.apply.pauseForApproval ? "you approved it" : "submitted automatically", screenshot: sentShot };
}
