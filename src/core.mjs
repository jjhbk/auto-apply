// Shared pieces every site uses: config, the browser, answers, form filling, the approval step and the log.
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import readline from "node:readline/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendLog } from "./log.mjs";
import { find, sentToCompany } from "./applied.mjs";
import { usLocation } from "./sites/ats.mjs";
import { canDraft, draftAnswer } from "./answer.mjs";

export const root = resolve(import.meta.dirname, "..");
export const args = process.argv.slice(2);
export const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
export const dryRun = args.includes("--dry-run");
// --auto-submit: submit without asking in the terminal, for this run only.
export const autoSubmit = args.includes("--auto-submit");
const configFile = resolve(root, arg("config") ?? "config/profile.json");
if (!existsSync(configFile)) {
  console.error(`No config at ${configFile}. Copy config/profile.example.json to config/profile.json and fill it in,\nor open this folder in Claude Code and run /setup-auto-apply.`);
  process.exit(1);
}
export const config = JSON.parse(readFileSync(configFile, "utf8"));
if (autoSubmit) config.apply.pauseForApproval = false;
export const mode = dryRun ? "dry-run" : "live";
export const profileDir = join(root, ".browser-profile");
export const screensDir = join(root, "logs", "screens");
mkdirSync(screensDir, { recursive: true });

for (const r of config.resumes) {
  r.path = resolve(root, r.file);
  if (!existsSync(r.path)) throw new Error(`Resume not found: ${r.path} (run "npm run resumes" or fix config)`);
}

// Each site runs in its own tab at the same time; this remembers which site the running code belongs to,
// so messages carry its name and questions bring its tab to the front.
export const siteContext = new AsyncLocalStorage();
const tag = () => { const t = siteContext.getStore()?.tag; return t ? `[auto-apply ${t}]` : "[auto-apply]"; };
// While a question waits on the terminal, other sites' messages are held back so the question stays in view.
let held = null;
export const say = (msg) => (held ? held.push(`${tag()} ${msg}`) : console.log(`${tag()} ${msg}`));
export const showTab = () => siteContext.getStore()?.page?.bringToFront().catch(() => {});
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pause = ([lo, hi]) => sleep((lo + Math.random() * (hi - lo)) * 1000);
// Questions from different sites wait their turn, so only one is on the terminal at a time.
let rl;
let asking = Promise.resolve();
export function ask(question) {
  const prefix = tag();
  const turn = asking.then(async () => {
    await showTab();
    rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
    held = [];
    try {
      return (await rl.question(`\n${prefix} ${question} `)).trim().toLowerCase();
    } finally {
      const later = held;
      held = null;
      for (const line of later) console.log(line);
    }
  });
  asking = turn.catch(() => {});
  return turn;
}
export const closeAsk = () => rl?.close();

// One Chromium profile holds every site's sign-in. Chromium is told not to offer to save passwords in it.
export function disablePasswordSaving() {
  const prefsFile = join(profileDir, "Default", "Preferences");
  if (existsSync(prefsFile)) return;
  mkdirSync(join(profileDir, "Default"), { recursive: true });
  writeFileSync(prefsFile, JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false } }));
}

export async function openBrowser() {
  disablePasswordSaving();
  const context = await chromium.launchPersistentContext(profileDir, { headless: false, viewport: null, args: ["--start-maximized"] });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

// Waits for you to sign in yourself. `isSignedIn` checks the current page.
export async function waitForSignIn(page, { name, url, isSignedIn }) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await sleep(3000);
  if (await isSignedIn(page)) return say(`Signed in to ${name}.`);
  await showTab();
  say(`Please sign in to ${name} in the browser window. I'll wait up to 10 minutes.`);
  say(`Your password goes only to ${name}; Auto Apply never sees it. The browser profile keeps you signed in next time.`);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await isSignedIn(page).catch(() => false)) return say(`Signed in to ${name}.`);
  }
  throw new Error(`Timed out waiting for the ${name} sign-in`);
}

// Whole words only, so "ai" doesn't match "chain".
const hasWord = (t, w) => new RegExp(`(^|[^a-z])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(t);

export function filterReason(job) {
  const t = (job.title ?? "").toLowerCase();
  const f = config.filters;
  if (!t) return "could not read the job title";
  if (job.skipReason) return job.skipReason;
  if (f.titleMustInclude?.length && !f.titleMustInclude.some((w) => hasWord(t, w))) return "title does not match your roles";
  const banned = f.titleMustNotInclude?.find((w) => hasWord(t, w));
  if (banned) return `title contains "${banned}"`;
  if (f.skipCompanies?.some((c) => (job.company ?? "").toLowerCase().includes(c.toLowerCase()))) return "company is on your skip list";
  if (job.alreadyApplied) return "already applied on the site";
  const before = find({ jobId: job.id, url: job.url, company: job.company, title: job.title });
  if (before) return `already applied to this role on ${before.at.slice(0, 10)} (${before.site}: ${before.company})`;
  // Many near-identical postings at one company (one per team or region) shouldn't all get an application.
  const cap = config.apply.maxPerCompany;
  if (cap?.count && sentToCompany(job.company, cap.days ?? 30) >= cap.count) return `already ${cap.count}+ applications to ${job.company} in the last ${cap.days ?? 30} days`;
  if (job.noLongerAccepting) return "no longer accepting applications";
  return null;
}

export function pickResume(title) {
  const t = title.toLowerCase();
  return config.resumes.find((r) => r.useWhenTitleMatches?.some((w) => t.includes(w))) ?? config.resumes.at(-1);
}

// Total experience from the earliest start date in config.experience to today.
export function totalExperience() {
  const starts = (config.experience ?? []).map((e) => e.from).sort();
  if (!starts.length) return null;
  const [y, m] = starts[0].split("-").map(Number);
  const now = new Date();
  const months = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
  return { years: Math.floor(months / 12), months: months % 12 };
}

// Answer for a form label: profile fields first, then the config's question patterns. "" means "ask me".
// An answer can carry a "textAnswer" for when the question is a text box rather than Yes/No buttons.
// `localPhone`: the site picks the country code in its own box, so send only the local 10 digits.
export function answerFor(label, kind = "text", { localPhone = false, job } = {}) {
  const l = label.toLowerCase();
  const p = config.profile;
  // On US jobs, where you are is your US city (you split your time between it and Bengaluru).
  if (p.usCity && job && usLocation(job.location) && /city|location|where .*(based|located|live)/.test(l) && !/relocat/.test(l)) return p.usCity;
  if (/first name/.test(l)) return p.firstName;
  if (/last name|surname|family name/.test(l)) return p.lastName;
  if (/^(full )?name\b|your name|legal name/.test(l)) return `${p.firstName} ${p.lastName}`;
  // profile.siteEmails: a different address on some sites (e.g. where the site emails you a code).
  if (/e-?mail/.test(l)) return p.siteEmails?.[job?.site] ?? p.email;
  if (/phone|mobile/.test(l) && !/country code/.test(l)) {
    const digits = p.phone.replace(/\D/g, "");
    return localPhone && digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : p.phone;
  }
  const total = totalExperience();
  if (total && /total .*years.*experience|years of (total|professional|overall) experience/.test(l)) return String(total.years);
  if (total && /additional months/.test(l)) return String(total.months);
  for (const a of config.answers) if (new RegExp(a.question, "i").test(l)) return kind === "text" && a.textAnswer ? a.textAnswer : a.answer;
  return undefined;
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export async function typeAndPick(page, el, value) {
  await el.fill("");
  await el.pressSequentially(value, { delay: 90 });
  const options = page.getByRole("option");
  await options.first().waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
  const match = options.filter({ hasText: new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first();
  if (await match.isVisible().catch(() => false)) await match.click();
  else if (await options.first().isVisible().catch(() => false)) await options.first().click();
}

// Reads every visible field inside `root`, including custom controls, and tags it so it can be filled.
// Kinds: text, textarea, select (native), combobox (searchable dropdown), radio, buttons (Yes/No buttons),
// checkboxes (pick from a list), file.
async function scanFields(root, prefix) {
  return root.evaluate((rootEl, prefix) => {
    const text = (el) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const out = [];
    let n = 0;
    const tagIt = (el) => { const t = `${prefix}-${n++}`; el.setAttribute("data-autoapply", t); return t; };
    const labelledBy = (el) => (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => text(document.getElementById(id))).filter(Boolean).join(" ");
    // The question for a group of options: the first nearby text that is more than the option labels themselves.
    const questionFor = (start, optionTexts) => {
      const strip = (t) => { for (const o of optionTexts.filter(Boolean)) t = t.replace(o, ""); return t.replace(/\s+/g, " ").trim(); };
      const candidates = [text(start.closest("fieldset")?.querySelector("legend")), labelledBy(start), start.getAttribute?.("aria-label"), text(start.previousElementSibling)];
      for (let up = start, i = 0; up && i < 6; up = up.parentElement, i++) { candidates.push(text(up.previousElementSibling)); candidates.push(text(up)); }
      return candidates.map((c) => strip(c ?? "")).find((c) => c && c.length < 400) ?? "";
    };
    const seenGroups = new Set();

    for (const el of rootEl.querySelectorAll("input, textarea, select")) {
      const type = (el.getAttribute("type") || el.tagName).toLowerCase();
      if (["hidden", "submit", "button", "search", "reset", "image"].includes(type)) continue;
      if (type !== "file" && type !== "checkbox" && type !== "radio" && !visible(el)) continue;
      // Hidden mirrors of custom controls (the real value behind a dropdown) aren't for typing into.
      if (type !== "file" && type !== "checkbox" && type !== "radio" && (el.getAttribute("aria-hidden") === "true" || (el.readOnly && el.tabIndex < 0))) continue;
      const group = el.closest("fieldset, [data-test-form-element], .fb-dash-form-element, .jobs-easy-apply-form-element, .application-question, .field") ?? el.parentElement;
      // Some fields have no <label>; their question is the nearest short text above them.
      let near = "";
      for (let up = el.parentElement, i = 0; up && i < 6 && !near; up = up.parentElement, i++) {
        const t = text(up);
        if (t && t.length < 200) near = t;
      }
      let label = text(el.labels?.[0]) || labelledBy(el) || el.getAttribute("aria-label") || text(group?.querySelector("legend, label")) || near || el.placeholder || el.name || "";
      // A dropdown whose only nearby text is its placeholder ("Select...") gets the question from further up.
      if (/^(select|choose|search)\b\W*$/i.test(label)) label = questionFor(el, [label]) || label;
      const required = el.required || el.getAttribute("aria-required") === "true" || /\*|required/i.test(label);

      if (type === "radio" || type === "checkbox") {
        // Options of one question share a name (or, for checkboxes, a fieldset/container).
        const container = el.closest("fieldset") ?? el.parentElement?.parentElement ?? el.parentElement;
        const key = el.name ? `${type}:${el.name}` : `${type}:${prefix}:${[...rootEl.querySelectorAll("*")].indexOf(container)}`;
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        const members = el.name ? [...rootEl.querySelectorAll(`input[type=${type}][name="${CSS.escape(el.name)}"]`)] : [...container.querySelectorAll(`input[type=${type}]`)];
        // A lone checkbox is a consent/opt-in box, handled separately (only required consent boxes get ticked).
        if (type === "checkbox" && members.length < 2) continue;
        // Newer forms wrap each option in role="radio" with the question as its aria-label and the option text beside it.
        const optionLabel = (r) => text(r.labels?.[0]) || text(r.closest('[role="radio"], [role="checkbox"], label')) || r.value;
        const wrapperAria = el.closest('[role="radio"]')?.getAttribute("aria-label");
        const fieldset = el.closest("fieldset");
        const question = text(fieldset?.querySelector("legend")) || wrapperAria || questionFor(fieldset ?? container, members.map(optionLabel));
        out.push({
          kind: type === "radio" ? "radio" : "checkboxes", label: question || label, required: type === "radio" || /\*|required/i.test(question),
          filled: members.some((r) => r.checked),
          options: members.map((r) => ({ tag: tagIt(r.closest('[role="radio"], [role="checkbox"]') ?? r), id: r.id, label: optionLabel(r), wrapped: !!r.closest('[role="radio"], [role="checkbox"]') })),
        });
        continue;
      }

      const tag = tagIt(el);
      const isCombo = el.getAttribute("role") === "combobox" || el.hasAttribute("aria-autocomplete") || el.getAttribute("aria-haspopup") === "listbox"
        || /select__input|dummyInput/i.test(el.className) || !!el.closest('[class*="select__control"], [class*="-control"][class*="css-"]');
      const filled = el.tagName === "SELECT" ? !/^(select( an option)?|--|please select)/i.test(text(el.selectedOptions?.[0])) && el.value !== ""
        // A searchable dropdown shows its chosen value next to the input, not in it.
        : isCombo ? !!text(el.closest('[class*="control"], [class*="container"]')?.querySelector('[class*="single-value"], [class*="singleValue"], [class*="multi-value"]')) || (el.value ?? "").trim() !== ""
        : (el.value ?? "").trim() !== "";
      const context = text(el.closest("section, form") ?? group).slice(0, 300);
      out.push({
        kind: type === "file" ? "file" : el.tagName === "SELECT" ? "select" : isCombo ? "combobox" : el.tagName === "TEXTAREA" ? "textarea" : "text",
        tag, domId: el.id || null, label: label.slice(0, 400), required, filled, context,
        options: el.tagName === "SELECT" ? [...el.options].map((o) => text(o)) : undefined,
        // Some sites show the limit as "0/20" in the field's helper text rather than a maxlength attribute.
        maxLength: el.maxLength > 0 && el.maxLength < 100000 ? el.maxLength
          : Number(`${text(document.getElementById(el.getAttribute("aria-describedby")?.split(" ")[0] ?? ""))} ${text(el.parentElement?.parentElement)}`.match(/\d+\/(\d+)/)?.[1]) || undefined,
        numeric: el.type === "number" || el.inputMode === "numeric",
      });
    }

    // Dropdowns built from a button that opens a list (Workday's "Select One").
    for (const b of rootEl.querySelectorAll('button[aria-haspopup="listbox"]')) {
      if (!visible(b)) continue;
      const shown = text(b);
      const label = text(b.labels?.[0]) || labelledBy(b) || text(document.querySelector(`label[for="${CSS.escape(b.id)}"]`))
        || questionFor(b.parentElement, [shown]) || (b.getAttribute("aria-label") ?? "").replace(/\s*(select one|required)\s*/gi, " ").trim();
      out.push({
        kind: "combobox", tag: tagIt(b), domId: b.id || null, label: label.slice(0, 400),
        required: /\*|required/i.test(`${label} ${b.getAttribute("aria-label") ?? ""}`) || b.getAttribute("aria-required") === "true",
        filled: !!shown && !/^(select one|select|choose|--)/i.test(shown), context: "",
      });
    }

    // Yes/No (or other short choice) buttons with no input behind them, e.g. Ashby's yes/no questions.
    const skipButton = /upload|attach|dropbox|google drive|submit|locate|enter manually|remove|delete|cancel|close|back|next|review|apply|save|add/i;
    const byParent = new Map();
    for (const b of rootEl.querySelectorAll('button:not([type="submit"]):not([type="reset"]), [role="button"]')) {
      const t = text(b);
      if (!visible(b) || !t || t.length > 40 || skipButton.test(t) || b.getAttribute("aria-haspopup")) continue;
      let holder = b.parentElement;
      for (let i = 0; i < 3 && holder && holder.querySelectorAll("button, [role=button]").length < 2; i++) holder = holder.parentElement;
      const list = byParent.get(holder) ?? [];
      list.push(b);
      byParent.set(holder, list);
    }
    for (const [parent, buttons] of byParent) {
      if (buttons.length < 2 || buttons.length > 8) continue;
      const pressed = (b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /\b(selected|active|checked|_active|isSelected)\b/i.test(b.className);
      const question = questionFor(parent, buttons.map(text));
      out.push({
        kind: "buttons", label: question, required: /\*|required/i.test(question) || true,
        filled: buttons.some(pressed),
        options: buttons.map((b) => ({ tag: tagIt(b), label: text(b) })),
      });
    }
    // One question can show up as both a dropdown and a hidden text box: keep the dropdown.
    const comboLabels = new Set(out.filter((f) => f.kind === "combobox").map((f) => f.label));
    return out.filter((f) => f.kind !== "text" || !comboLabels.has(f.label));
  }, prefix);
}

// Ticks required consent boxes ("I agree to the privacy notice"); leaves every other single checkbox alone.
async function tickConsent(root) {
  const boxes = root.locator('input[type="checkbox"]');
  for (let i = 0; i < (await boxes.count()); i++) {
    const box = boxes.nth(i);
    const info = await box.evaluate((el) => ({
      label: (el.labels?.[0]?.textContent ?? el.closest("label, div")?.textContent ?? "").replace(/\s+/g, " ").trim(),
      required: el.required || el.getAttribute("aria-required") === "true" || /\*/.test(el.labels?.[0]?.textContent ?? ""),
      checked: el.checked,
    })).catch(() => null);
    if (info && info.required && !info.checked && /agree|consent|acknowledge|privacy|terms|certify|confirm/i.test(info.label)) {
      await box.check({ force: true, timeout: 5000 }).catch(() => box.evaluate((el) => el.click()));
    }
  }
}

// Fills what it can inside `root`. Returns labels of required fields it could not answer.
// state: { step, resumeUploaded, drafted, job, answered }. opts.localPhone, opts.resumeButton (regex for an upload button).
export async function fillForm(page, root, resume, state, opts = {}) {
  state.answered ??= new Set();
  // Upload the resume before anything else: many forms read it and rebuild themselves to pre-fill the fields,
  // which would throw away anything typed (and every field found) before.
  if (!state.resumeUploaded) {
    const resumeInput = root.locator('input[type="file"]');
    for (let i = 0; i < (await resumeInput.count()); i++) {
      const input = resumeInput.nth(i);
      const context = await input.evaluate((el) => {
        const t = (n) => n?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        let up = el.parentElement;
        for (let k = 0; k < 5 && up && t(up).length < 15; k++) up = up.parentElement;
        return `${el.name} ${el.id} ${el.getAttribute("aria-label") ?? ""} ${t(up).slice(0, 200)}`;
      });
      if (/resume|cv/i.test(context) && !/cover/i.test(context.split(" ").slice(0, 3).join(" "))) {
        await input.setInputFiles(resume.path);
        state.resumeUploaded = true;
        say("  uploaded the resume; waiting for the form to pre-fill");
        await sleep(6000);
        break;
      }
    }
  }
  // Some forms have no file field until an upload button is clicked, which opens a file picker.
  const uploadButton = root.getByText(opts.resumeButton ?? /^upload resume$/i).first();
  if (!state.resumeUploaded && (await uploadButton.isVisible().catch(() => false))) {
    const chooser = page.waitForEvent("filechooser", { timeout: 8000 });
    await uploadButton.click();
    await (await chooser).setFiles(resume.path);
    state.resumeUploaded = true;
    await sleep(4000);
  }
  const fields = await scanFields(root, `step${++state.step}`);
  const missing = [];
  for (const f of fields) {
    try {
      await fillField(page, f, resume, state, opts, missing);
    } catch (err) {
      // One stubborn field shouldn't sink the application: note it and carry on.
      say(`  couldn't fill "${f.label.slice(0, 60)}": ${err.message.split("\n")[0]}`);
      if (f.required) missing.push(f.label);
    }
  }
  await tickConsent(root);
  return missing;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const pickOption = (options, answer) => options.find((o) => sameText(o, answer))
  ?? options.find((o) => o.toLowerCase().startsWith(answer.toLowerCase()))
  ?? options.find((o) => o.toLowerCase().includes(answer.toLowerCase()))
  ?? options.find((o) => answer.toLowerCase().includes(o.toLowerCase()) && o.length > 1);

// Opens a searchable dropdown and returns the option texts it shows (empty when it only searches as you type).
// The options belonging to this dropdown: its own listbox (aria-controls / aria-owns) when it names one.
async function optionsFor(page, el) {
  const listId = await el.evaluate((e) => e.getAttribute("aria-controls") || e.getAttribute("aria-owns")).catch(() => null);
  const own = listId ? page.locator(`[id="${listId}"]`).getByRole("option") : null;
  if (own && (await own.count().catch(() => 0))) return own;
  return page.getByRole("option");
}

async function openCombobox(page, el) {
  await el.click({ timeout: 5000 }).catch(() => el.focus());
  await sleep(700);
  const options = await optionsFor(page, el);
  return (await options.allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 300);
}

const isFocused = (el) => el.evaluate((e) => document.activeElement === e).catch(() => false);

export async function chooseInCombobox(page, el, answer) {
  // Typing narrows the list (and fills async searches such as cities); then click the best match.
  await el.click({ timeout: 5000 }).catch(() => {});
  if (!(await isFocused(el))) await el.focus().catch(() => {});
  // Only type when this field has the focus, so keystrokes never land in another field.
  if (await isFocused(el)) {
    await el.fill("", { timeout: 3000 }).catch(() => {});
    await page.keyboard.type(answer.slice(0, 40), { delay: 60 });
  }
  let options = await optionsFor(page, el);
  await options.first().waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
  options = await optionsFor(page, el);
  let texts = (await options.allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").trim());
  if (!texts.length) {
    // A dropdown you can't type into: open it and pick from the full list.
    await page.keyboard.press("Escape").catch(() => {});
    await el.click({ timeout: 5000, force: true }).catch(() => {});
    await sleep(700);
    options = await optionsFor(page, el);
    texts = (await options.allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").trim());
  }
  const best = pickOption(texts, answer);
  if (best) await options.filter({ hasText: new RegExp(`^\\s*${escapeRe(best)}\\s*$`, "i") }).first().click({ timeout: 5000 }).catch(() => options.nth(texts.indexOf(best)).click());
  else if (texts.length) await options.first().click();
  else if (await isFocused(el)) await page.keyboard.press("Enter");
  await sleep(400);
}

const SELF_ID = /gender|sex\b|pronoun|hispanic|latin[oax]|race|ethnic|veteran|disabilit|sexual orientation|transgender/i;
const DECLINE = /decline|don.?t wish|do not wish|prefer not|not to (answer|say|disclose|self)|choose not|rather not/i;

async function fillField(page, f, resume, state, opts, missing) {
  // Prefer the field's own id: forms that rebuild themselves keep ids but drop the tag Auto Apply added.
  const el = f.domId ? page.locator(`[id="${f.domId.replace(/"/g, '\\"')}"]`).first() : page.locator(`[data-autoapply="${f.tag}"]`);
  if (f.kind === "file") {
    // Upload the chosen resume once per application; leave cover-letter uploads alone.
    if (!state.resumeUploaded && /resume|cv/i.test(`${f.label} ${f.context}`) && !/cover/i.test(f.label)) {
      await el.setInputFiles(resume.path);
      state.resumeUploaded = true;
      await sleep(2500);
    }
    return;
  }
  // Choice questions answered on an earlier pass stay as they are (clicking a toggle twice would undo it).
  if (["buttons", "checkboxes"].includes(f.kind) && state.answered.has(f.label)) return;
  // Your name and email come from the config even when the site prefilled the account's own.
  const ownDetail = /first name|last name|surname|e-?mail/i.test(f.label) && f.kind === "text";
  if (f.filled && !ownDetail) return;
  let answer = answerFor(f.label, ["textarea", "combobox"].includes(f.kind) ? "text" : f.kind === "buttons" || f.kind === "checkboxes" ? "radio" : f.kind, { ...opts, job: state.job });
  if (f.filled && ownDetail) {
    if (answer && (await el.inputValue()) !== answer) await el.fill(answer, { timeout: 8000 });
    return;
  }

  // The real choices on offer: from the form, or (for a searchable dropdown) by opening it.
  let choices = f.kind === "select" ? f.options.filter((o) => o && !/^(select( an option)?|--|please select)/i.test(o))
    : ["radio", "buttons", "checkboxes"].includes(f.kind) ? f.options.map((o) => o.label) : null;
  if (f.kind === "combobox") {
    const shown = await openCombobox(page, el);
    choices = shown.length && shown.length < 300 && !/no options|type to search|start typing/i.test(shown.join(" ")) ? shown : null;
    if (await isFocused(el)) await page.keyboard.press("Escape").catch(() => {});
  }
  // A saved answer that isn't one of the choices ("Bengaluru" for "Do you meet the location requirement?") is dropped
  // so a fitting one gets drafted.
  if (answer && choices && !pickOption(choices, answer)) answer = undefined;
  // Voluntary self-identification (gender, race, veteran, disability): never guessed. Unless your config answers it,
  // Auto Apply picks the form's own "decline to answer" choice.
  if (!answer && choices && SELF_ID.test(f.label)) answer = choices.find((c) => DECLINE.test(c));

  // Free-text boxes ("What interests you about this company?") are written even when optional: they're the application.
  // A question already answered on an earlier pass keeps that answer, so the form never contradicts itself.
  const earlier = state.drafted.find((d) => d.question === f.label);
  if (!answer && earlier && (!choices || pickOption(choices, earlier.answer))) answer = earlier.answer;
  if (!answer && !earlier && (f.required || f.kind === "textarea") && canDraft()) {
    say(`  writing an answer: ${f.label.slice(0, 80)}`);
    answer = await draftAnswer(config, resume, {
      question: f.label,
      kind: choices ? "select" : "text",
      long: f.kind === "textarea",
      // Long lists (countries) are searched by typing, so the model answers freely.
      options: choices && choices.length <= 80 ? choices : undefined,
      maxLength: f.maxLength, numeric: f.numeric, job: state.job,
    }).catch((err) => {
      say(`  (could not draft an answer: ${err.message})`);
      return null;
    });
    if (answer) {
      state.drafted.push({ question: f.label, answer });
      say(`  drafted: ${f.label.slice(0, 80)} -> ${answer.slice(0, 120)}`);
    }
  }
  if (!answer) {
    if (f.required) missing.push(f.label);
    return;
  }

  if (["radio", "buttons", "checkboxes"].includes(f.kind)) {
    const label = pickOption(choices, answer);
    const opt = f.options.find((o) => o.label === label);
    if (!opt) { missing.push(f.label); return; }
    const target = page.locator(`[data-autoapply="${opt.tag}"]`);
    if (f.kind === "buttons" || opt.wrapped) await target.click({ timeout: 5000 });
    // Styled radios and checkboxes hide the real input; clicking its label works where checking the input times out.
    else await target.check({ force: true, timeout: 5000 }).catch(() => page.locator(`label:has([data-autoapply="${opt.tag}"]), label[for="${opt.id}"]`).first().click({ timeout: 5000 }));
    state.answered.add(f.label);
  } else if (f.kind === "select") {
    const opt = pickOption(f.options, answer);
    if (opt) await el.selectOption({ label: opt });
    else missing.push(f.label);
  } else if (f.kind === "combobox" || (f.kind === "text" && /city|location/i.test(f.label) && !/relocat/i.test(f.label))) {
    // Searchable dropdowns and city pickers only keep a value picked from their own list.
    await chooseInCombobox(page, el, answer);
  } else {
    // Some inputs (phone boxes with a country picker) refuse a direct fill; typing into them works.
    await el.fill(answer, { timeout: 5000 }).catch(async () => {
      await el.click({ timeout: 5000, force: true }).catch(() => el.focus());
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type(answer, { delay: 30 });
    });
  }
}

export async function capture(page, root, job, why) {
  const shot = join(screensDir, `${String(job.id).replace(/[^\w.-]/g, "_")}-${mode}-${why}.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  const text = (await root.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600);
  return { screenshot: shot, formText: text };
}

export function showDrafted(state) {
  for (const d of state.drafted) say(`  Drafted from your resume: "${d.question.slice(0, 90)}" -> ${d.answer}`);
}

// The one place that decides whether to submit. Returns "submit", "skip" or "quit".
export async function approve(job, resume, state) {
  showDrafted(state);
  if (dryRun) return "dry-run";
  if (!config.apply.pauseForApproval) return "submit";
  const answer = await ask(`Submit "${job.title}" at ${job.company} (${job.site}) with your ${resume.name} resume? Check the browser. [y]es / [n]o skip / [q]uit:`);
  return answer === "y" ? "submit" : answer === "q" ? "quit" : "skip";
}

// When a step has questions Auto Apply can't answer: in a real run with approval on, wait for you; otherwise give up on the job.
export async function askForHelp(what) {
  if (dryRun || !config.apply.pauseForApproval) return "give-up";
  const answer = await ask(`This step needs you: ${what}. Fill it in the browser, then press Enter (or type s to skip this job):`);
  return answer === "s" ? "skip" : "continue";
}

export { appendLog };
