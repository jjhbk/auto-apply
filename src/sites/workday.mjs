// Workday career sites (company.wdN.myworkdayjobs.com). Companies are listed in config.workday as
// { "tenant": "nvidia", "host": "nvidia.wd5.myworkdayjobs.com", "site": "NVIDIAExternalCareerSite" }.
// Jobs come from each site's public search. Applying needs an account on that company's Workday site: you sign in
// or create it yourself the first time; Auto Apply never types passwords. The browser profile keeps you signed in.
import { join } from "node:path";
import { config, mode, say, sleep, screensDir, fillForm, capture, approve, showTab } from "../core.mjs";
import { locationOk, htmlToText } from "./ats.mjs";

export const name = "Workday";
export const id = "workday";

async function search(t, text, offset) {
  const res = await fetch(`https://${t.host}/wday/cxs/${t.tenant}/${t.site}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`search returned ${res.status}`);
  return res.json();
}

async function details(t, path) {
  const res = await fetch(`https://${t.host}/wday/cxs/${t.tenant}/${t.site}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  return res.ok ? res.json() : null;
}

export async function* findJobs() {
  for (const t of config.workday ?? []) {
    const seen = new Set();
    for (const role of config.search.roles) {
      let found;
      try {
        found = await search(t, role, 0);
      } catch (err) {
        say(`  Workday ${t.tenant}: couldn't search (${err.message})`);
        continue;
      }
      const near = (found.jobPostings ?? []).filter((j) => locationOk(j.locationsText ?? ""));
      say(`Workday: ${t.tenant} "${role}": ${found.total} results, ${near.length} in your locations on the first page`);
      for (const j of near) {
        if (seen.has(j.externalPath)) continue;
        seen.add(j.externalPath);
        yield {
          id: `workday:${t.tenant}:${j.externalPath.split("_").pop()}`,
          url: `https://${t.host}/${t.site}${j.externalPath}`,
          title: j.title,
          company: t.company ?? t.tenant,
          location: j.locationsText,
          search: `workday:${t.tenant}`,
          load: async () => ({ description: htmlToText((await details(t, j.externalPath))?.jobPostingInfo?.jobDescription ?? "").slice(0, 5000) }),
        };
      }
    }
  }
}

const auto = (id) => `[data-automation-id="${id}"]`;
const next = (page) => page.locator(`button${auto("pageFooterNextButton")}, button${auto("bottom-navigation-next-button")}`).first();

// Waits for you to sign in or create an account on this company's Workday site.
async function waitForAccount(page) {
  const inFlow = () => next(page).isVisible().catch(() => false);
  if (await inFlow()) return true;
  const signIn = page.locator(`${auto("signInContent")}, ${auto("createAccountLink")}, ${auto("signInLink")}, input[type="password"]`).first();
  if (!(await signIn.isVisible().catch(() => false))) return inFlow();
  await showTab();
  say("  This company's Workday site needs an account. Please sign in, or create one, in the browser window; I'll wait up to 10 minutes.");
  say("  Auto Apply never types your password. The browser profile keeps you signed in for this company next time.");
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await inFlow()) return true;
  }
  return false;
}

export async function apply(page, job, resume, state) {
  await page.goto(job.url, { waitUntil: "domcontentloaded" });
  await sleep(5000);
  const applyButton = page.locator(`a${auto("adventureButton")}, button${auto("adventureButton")}`).first();
  if (!(await applyButton.isVisible().catch(() => false))) return { status: "skipped", reason: "no Apply button (closed, or already applied)" };
  await applyButton.click();
  await sleep(3000);
  // Prefer letting Workday read the resume; "Apply Manually" when that isn't offered.
  const choice = page.locator(`${auto("autofillWithResume")}, ${auto("applyManually")}`).first();
  if (await choice.isVisible().catch(() => false)) {
    const autofill = page.locator(auto("autofillWithResume"));
    await ((await autofill.isVisible().catch(() => false)) ? autofill : page.locator(auto("applyManually"))).click();
    await sleep(3000);
  }
  if (!(await waitForAccount(page))) return { status: "needs-input", reason: "waited for you to sign in to this company's Workday site; it didn't happen" };

  let lastHeading = "";
  for (let step = 0; step < 12; step++) {
    await sleep(3000);
    const body = page.locator("body");
    const heading = (await page.locator(`${auto("progressBarActiveStep")}, h2`).first().innerText().catch(() => "")).trim();
    // Workday's resume step: upload once, then let it read the file.
    const upload = page.locator(`input[type="file"]${auto("file-upload-input-ref")}, input[type="file"]`).first();
    if (!state.resumeUploaded && (await upload.count())) {
      await upload.setInputFiles(resume.path).catch(() => {});
      state.resumeUploaded = true;
      say("  uploaded the resume; waiting for Workday to read it");
      await sleep(8000);
    }
    const nextButton = next(page);
    const nextText = (await nextButton.innerText().catch(() => "")).trim();
    if (/^submit$/i.test(nextText) || /review/i.test(heading)) {
      const shot = join(screensDir, `${job.id.replace(/[^\w.-]/g, "_")}-${mode}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => page.screenshot({ path: shot }));
      const decision = await approve(job, resume, state);
      if (decision === "dry-run") return { status: "dry-run", reason: "every page filled up to Review; not submitted", screenshot: shot };
      if (decision !== "submit") return { status: "skipped", reason: decision === "quit" ? "you stopped the run" : "you chose not to submit", quit: decision === "quit" };
      await nextButton.click();
      const sent = await page.getByText(/application (has been )?submitted|thank you for applying|congratulations/i).first()
        .waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
      const sentShot = join(screensDir, `${job.id.replace(/[^\w.-]/g, "_")}-${mode}-sent.png`);
      await page.screenshot({ path: sentShot }).catch(() => {});
      if (!sent) return { status: "error", reason: "clicked Submit but saw no confirmation; check the company's Workday site", screenshot: sentShot, submitted: true };
      return { status: "applied", reason: config.apply.pauseForApproval ? "you approved it" : "submitted automatically", screenshot: sentShot };
    }
    const missing = await fillForm(page, body, resume, state, { resumeButton: /^select files?$/i });
    if (missing.length) {
      const seen = await capture(page, body, job, "needs-input");
      return { status: "needs-input", reason: `on "${heading}": ${missing.join(" | ")}`, ...seen };
    }
    if (heading && heading === lastHeading && step > 0) {
      // Still on the same page after pressing Next: Workday found something wrong.
      const errors = (await page.locator(`${auto("errorMessage")}, [role="alert"]`).allInnerTexts().catch(() => [])).join(" | ");
      const seen = await capture(page, body, job, "stuck");
      return { status: "needs-input", reason: `Workday didn't accept "${heading}"${errors ? `: ${errors.slice(0, 300)}` : ""}`, ...seen };
    }
    lastHeading = heading;
    if (!(await nextButton.isVisible().catch(() => false))) {
      const seen = await capture(page, body, job, "no-next");
      return { status: "error", reason: `no Next button on "${heading}"`, ...seen };
    }
    await nextButton.click();
  }
  return { status: "error", reason: "the application had more pages than expected" };
}
