// Y Combinator's Work at a Startup: one profile for every YC company; applying sends a message to a founder.
import { join } from "node:path";
import { config, mode, say, sleep, screensDir, waitForSignIn, approve } from "../core.mjs";
import { draftAnswer } from "../answer.mjs";
import { locationOk } from "./ats.mjs";

export const name = "Work at a Startup";
export const id = "yc";

// Signed in when the top menu shows "My profile".
const isSignedIn = async (page) => /workatastartup\.com/.test(page.url())
  && (await page.getByText(/^my profile$/i).first().isVisible().catch(() => false));
export const signIn = (page) => waitForSignIn(page, { name, url: "https://www.workatastartup.com/companies", isSignedIn });

async function jobLinks(page) {
  return page.evaluate(() => {
    const ids = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      const m = a.getAttribute("href").match(/\/jobs\/(\d+)/);
      if (m) ids.add(m[1]);
    }
    return [...ids];
  });
}

async function readJob(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await sleep(4000);
  return page.evaluate(() => {
    // The page title is "Job title at Company | Y Combinator's Work at a Startup".
    const head = document.title.split(" | ")[0];
    const at = head.lastIndexOf(" at ");
    const body = document.body.innerText;
    // The summary block under the title: salary, tagline, locations, type, visa, experience.
    const top = body.slice(body.indexOf(head.slice(0, 20)), body.indexOf("About ") > 0 ? body.indexOf("About ") : 1200);
    return {
      title: at > 0 ? head.slice(0, at) : head,
      company: at > 0 ? head.slice(at + 4) : "",
      location: top.split("\n").find((l) => /, [A-Z]{2}\b|remote/i.test(l)) ?? "",
      visaNotRequired: /visa not required/i.test(top),
      description: body.slice(body.indexOf("About "), body.indexOf("About ") + 4500),
      alreadyApplied: /\bapplied\b/i.test(top) && !/apply\n/i.test(top),
    };
  });
}

export async function* findJobs(page) {
  const max = config.search.maxJobsPerSearch;
  for (const role of config.search.roles) {
    say(`Work at a Startup: searching "${role}"`);
    await page.goto(`https://www.workatastartup.com/companies?query=${encodeURIComponent(role)}&role=eng&sortBy=created_desc&layout=list-compact`, { waitUntil: "domcontentloaded" });
    await sleep(6000);
    let ids = await jobLinks(page);
    // More companies load as you scroll.
    for (let i = 0; i < 8 && ids.length < max * 2; i++) {
      await page.mouse.wheel(0, 4000);
      await sleep(1500);
      ids = await jobLinks(page);
    }
    say(`Found ${ids.length} jobs.`);
    for (const jobId of ids.slice(0, max * 2)) {
      const url = `https://www.workatastartup.com/jobs/${jobId}`;
      yield {
        id: `yc:${jobId}`, url, search: `${role} (YC)`,
        load: async () => {
          const job = await readJob(page, url);
          // In India or Asia, or remote with no US work authorisation needed.
          // "Remote" only counts when nothing else in the location or title ties the job to another country,
          // e.g. "Forward Deployed Construction Engineer (Germany)" with "Remote, DE".
          const elsewhere = job.location.replace(/remote|\(|\)|[,/|•·-]/gi, " ").trim()
            || (/\(([^)]+)\)\s*$/.exec(job.title)?.[1] ?? "").replace(/fde|remote|india|bengaluru|bangalore/gi, "").trim();
          // Work at a Startup writes India as the country code: "Noida, UP, IN".
          const ok = locationOk(job.location) || /,\s*IN\b/.test(job.location) || (job.visaNotRequired && /remote/i.test(job.location) && !elsewhere);
          // config.siteSearch.ycAnyLocation: apply wherever the job is.
          return ok || config.siteSearch?.ycAnyLocation ? job : { ...job, skipReason: `location "${job.location}" isn't in your locations or needs US work authorisation` };
        },
      };
    }
  }
}

export async function apply(page, job, resume, state) {
  if (job.skipReason) return { status: "skipped", reason: job.skipReason };
  const applyButton = page.getByText("Apply", { exact: true }).first();
  if (!(await applyButton.isVisible().catch(() => false))) return { status: "skipped", reason: "no Apply button (already applied or closed)" };
  await applyButton.click();
  const send = page.getByRole("button", { name: /^send$/i });
  await send.waitFor({ state: "visible", timeout: 15_000 });
  const dialog = page.locator('[role="dialog"], .ReactModal__Content, [aria-modal="true"]').filter({ has: send }).last();
  const box = dialog.locator("textarea").first();
  const founder = ((await dialog.innerText().catch(() => "")).match(/Reach out to (.+?) at /) ?? [])[1] ?? "the founders";
  const note = await draftAnswer(config, resume, {
    question: `A short message to ${founder} at ${job.company} for the ${job.title} role: who you are, what you're looking for, and why ${job.company} interests you. Write it to ${founder.split(" ")[0]} as a person, plainly, the way a human would.`,
    kind: "text", long: true, maxLength: 700, job,
  });
  if (!note || note.length < 50) return { status: "needs-input", reason: "couldn't write a message of at least 50 characters" };
  state.drafted.push({ question: `Message to ${founder}`, answer: note });
  await box.fill(note);
  // Any other boxes in the form ("the most impressive thing you have built or achieved *") are questions to answer too.
  const boxes = dialog.locator("textarea");
  for (let i = 1; i < (await boxes.count()); i++) {
    const question = await boxes.nth(i).evaluate((el) => {
      if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
      if (el.id && document.querySelector(`label[for="${el.id}"]`)) return document.querySelector(`label[for="${el.id}"]`).innerText;
      // Otherwise the nearest text above the box.
      for (let up = el; up && up !== document.body; up = up.parentElement) {
        for (let prev = up.previousElementSibling; prev; prev = prev.previousElementSibling) {
          const t = prev.innerText?.trim();
          if (t) return t.split("\n").at(-1);
        }
      }
      return el.placeholder ?? "";
    });
    const answer = await draftAnswer(config, resume, { question, kind: "text", maxLength: 400, job });
    if (!answer) return { status: "needs-input", reason: `couldn't answer "${question.slice(0, 100)}"` };
    state.drafted.push({ question, answer });
    say(`  drafted: ${question.slice(0, 80)} -> ${answer.slice(0, 120)}`);
    await boxes.nth(i).fill(answer);
  }
  await sleep(800);
  const close = dialog.getByRole("button", { name: /^close$/i });
  // Send stays greyed out while a required box is empty.
  if (!(await send.isEnabled().catch(() => false))) {
    const shot = join(screensDir, `${job.id.replace(":", "_")}-${mode}-send-disabled.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    await close.click().catch(() => page.keyboard.press("Escape"));
    return { status: "needs-input", reason: "Send stayed disabled: the form has a required field Auto Apply didn't fill", screenshot: shot };
  }
  const shot = join(screensDir, `${job.id.replace(":", "_")}-${mode}.png`);
  await page.screenshot({ path: shot });
  const decision = await approve(job, resume, state);
  if (decision !== "submit") {
    await close.click().catch(() => page.keyboard.press("Escape"));
    if (decision === "dry-run") return { status: "dry-run", reason: "message written, then closed; nothing was sent", screenshot: shot };
    return { status: "skipped", reason: decision === "quit" ? "you stopped the run" : "you chose not to send", quit: decision === "quit" };
  }
  await send.click();
  const closed = await send.waitFor({ state: "hidden", timeout: 15_000 }).then(() => true, () => false);
  // The form closing isn't proof: reload the job and look for "Applied" where the Apply button was.
  await sleep(2000);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(3500);
  const sent = closed && !(await page.getByText("Apply", { exact: true }).first().isVisible().catch(() => false))
    && (await page.getByText(/^applied$/i).first().isVisible().catch(() => false));
  const sentShot = join(screensDir, `${job.id.replace(":", "_")}-${mode}-sent.png`);
  await page.screenshot({ path: sentShot }).catch(() => {});
  if (!sent) return closed
    ? { status: "error", reason: "the message box closed but the job doesn't show Applied, so it probably wasn't sent; check the Inbox on Work at a Startup", screenshot: sentShot }
    : { status: "error", reason: "clicked Send but the message box didn't close; check the Inbox on Work at a Startup", screenshot: sentShot, submitted: true };
  return { status: "applied", reason: config.apply.pauseForApproval ? "you approved it" : "sent automatically", screenshot: sentShot };
}
