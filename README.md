# Auto Apply

Job applications from your own machine.

Auto Apply opens a Chromium window you can see, finds jobs for the roles in your config, and fills their application forms with the right resume. You sign in to each site yourself, and you solve any CAPTCHA or emailed code. Answers come from your config and resume; open questions are drafted by a model (with your own API key) that sticks to what your resume shows. It applies a few minutes apart on each site and never applies to the same job twice.

## Get started with Claude

The quickest way to set it up is with [Claude Code](https://claude.com/claude-code) on your own machine:

```bash
git clone <this repo> auto-apply && cd auto-apply
claude
```

Then type `/setup-auto-apply` (or just say "set this up for me"). Claude installs what's needed, reads your resume, writes your config and resumes, has you sign in to each site, and runs a dry run with you. The steps it follows are in [`.claude/skills/setup-auto-apply/SKILL.md`](.claude/skills/setup-auto-apply/SKILL.md).

## Set it up by hand

You need Node 20+, Python 3 and LibreOffice.

```bash
npm run setup                                        # npm packages, Playwright's Chromium, Python venv for resumes
cp config/profile.example.json config/profile.json   # then fill in your details, roles, locations and answers
cp resumes/example.html resumes/my-role.html         # then write your resume; list it under "resumes" in the config
npm run resumes                                      # builds .docx and .pdf from resumes/*.html
echo "OPENAI_API_KEY=..." > .env                     # optional: lets it draft answers to open questions
npm run signin -- --site=wellfound,yc                # sign in to each site once
npm run dry-run -- --limit=1                         # fills one form per site, sends nothing
```

Your config, resumes, `.env`, sign-ins, logs and applied list are all git-ignored and stay on your machine.

## Sites

| Site | How Auto Apply finds jobs | Sign-in |
| --- | --- | --- |
| `linkedin` | LinkedIn job search with your filters; Easy Apply forms only | yours, once |
| `wellfound` | Wellfound role pages and keyword search; writes the note to the company | yours, once |
| `yc` | Y Combinator's Work at a Startup; writes a short message to the founder | yours, once |
| `greenhouse`, `lever`, `ashby` | the public job feeds of the companies listed under `ats` in the config | none |
| `workday` | the public job search of each company under `workday` in the config | one account per company, created and signed in by you |

## Run it

```bash
npm run signin -- --site=linkedin,wellfound,yc   # sign in to each site once; sessions are saved locally
npm run open -- --site=yc                        # open a site with no time limit, to edit your profile there
npm run dry-run      # fills forms up to Submit, then discards them. Nothing is sent.
npm start -- --site=greenhouse,ashby   # only these sites this run
npm start            # real run (with pauseForApproval on, you approve each submit with y / n / q)
npm run log          # every job it applied to, skipped, or couldn't finish
npm run applied      # every job an application was sent to (the no-repeats list)
```

The first time, sign in to each site in the window that opens. **Auto Apply never sees, types or stores your passwords.** Chromium keeps each site's sign-in cookie in one profile, `.browser-profile/` (ignored by git, password saving turned off), so you stay signed in. Delete that folder to sign out everywhere. Only one Auto Apply window can use the profile at a time.

Without `--site`, Auto Apply runs the sites listed under `sites` in the config: Wellfound, Work at a Startup, Greenhouse and Ashby, the ones that fill forms reliably. Add `lever`, `workday` or `linkedin` there, or name them with `--site`, to include them.

All the sites in a run go at the same time, each in its own tab of the one window. Every message in the terminal starts with the site's name, for example `[auto-apply yc]`. Questions for you come one at a time, and the tab they're about comes to the front first. If you answer `q` to one, every site stops after its current job.

Options: `--retry` tries again the jobs that stopped on questions it couldn't answer (after you've added answers to the config; otherwise they're skipped); `--limit=3` caps the applications each site sends (or, in a dry run, forms it fills to Submit) this run; `--auto-submit` submits without asking in the terminal, for that run only; `--config=path.json` uses another config.

## Config: `config/profile.json`

- **resumes**: which PDF to upload. A job whose title contains one of `useWhenTitleMatches` gets that resume; otherwise the last one (AI Engineer).
- **search**: roles, locations, `easyApplyOnly`, `postedWithin` (`day` / `week` / `month`), `workplace` (`onsite`, `hybrid`, `remote`), `experienceLevels` (`internship`, `entry`, `associate`, `mid-senior`, `director`, `executive`).
- **filters**: words a title must or must not contain, and companies to skip. Auto Apply also skips a role it already applied to at the same company, on any site.
- **ats**: company job boards to check, by board name, e.g. `"ashby": ["notion", "cursor"]` for jobs.ashbyhq.com/notion. A job counts if its location mentions India, Bengaluru, Hyderabad, APAC, Asia or "anywhere"; set `siteSearch.atsAcceptAnyRemote` to also take plain "Remote" (often remote in the US only), or `siteSearch.atsLocations` to a pattern of your own (the config now includes US cities and states).
- **workday**: company Workday sites, e.g. `{ "tenant": "nvidia", "host": "nvidia.wd5.myworkdayjobs.com", "site": "NVIDIAExternalCareerSite", "company": "NVIDIA" }` (the host and site are in the company's careers URL). The first time Auto Apply applies at a company, Workday asks you to sign in or create an account there; Auto Apply waits up to 10 minutes for you to do it in the window and never types the password.
- **siteSearch**: `ycAnyLocation` (`true`: on Work at a Startup, apply to matching roles in any country, including US-only ones), `wellfoundLocations` (Wellfound location pages, default `bangalore` and `india`), or `wellfound` as a list of search URLs to use instead.
- **apply**: `pauseForApproval` (keep this `true` unless you want it to submit on its own), `maxApplicationsPerRun` (per site), `maxPerCompany` (default 3 applications per company in 30 days, so a company's near-identical postings don't all get one), `minutesBetweenApplications` (after a site sends an application, that site waits a random time in this range before its next one, while the other sites carry on; default 5 to 10 minutes), and a short random wait between jobs it only looks at.
- **profile.siteEmails**: a different email on some sites, e.g. `{ "greenhouse": "other@gmail.com" }`. Greenhouse emails a code to this address before it accepts an application.
- **profile.workAuthorization**: where you may work. Auto Apply answers sponsorship and work-authorisation questions from this, for the country of each job: for a US job it answers that you need sponsorship and aren't yet authorised; for an India job, the opposite.
- **experience** and **education**: the dates on your resume. LinkedIn asks applicants to complete each job on their LinkedIn profile (dates, city) and their education. Auto Apply matches each entry by company or school name and fills it from here. "Total years of experience" questions are worked out from the earliest start date.
- **profile** and **answers**: what to type into form fields LinkedIn hasn't already filled. `question` is a pattern matched against the field's label. An empty `answer` means "ask me": in a real run Auto Apply pauses so you can fill the field in the browser and press Enter; in a dry run it logs the question as `needs-input`. An answer can also have a `textAnswer`, used when the same question comes as a text box instead of Yes/No buttons (for example "Can you join within 30 days?" gets Yes as a button and 7 as text).

## Questions your config doesn't cover

Put `ANTHROPIC_API_KEY=...` (or `OPENAI_API_KEY=...`) in a `.env` file in this folder (it's git-ignored). When a required question has no answer in your config, Auto Apply sends the question, your resume text and your config (never your phone number) to the model and fills in its reply. The model answers every question from those facts, honestly: 0 years or No for something your resume doesn't show, Yes for willingness and availability questions. It only gives up on personal details that aren't in your config, and then Auto Apply pauses for you (or skips the job with `--auto-submit`). Every drafted answer is printed in the terminal, listed before you approve Submit, and saved in the log under `drafted`. Without a key, Auto Apply pauses on those questions instead.

## The log

`logs/applications.jsonl` has one line per job: time, mode, site, search, job id, title, company, link, resume, status, reason and drafted answers. Status is one of:

- `applied`: submitted (after your yes, in approval mode)
- `dry-run`: filled up to Submit, then discarded
- `skipped`: filtered out, already applied, not Easy Apply, or you said no
- `needs-input`: a required question had no answer in your config
- `needs-code`: Greenhouse is waiting for your emailed verification code; the job stays out of the applied database until the site confirms submission
- `error`: the form did something unexpected

A screenshot of each form at the Submit step is saved in `logs/screens/`. Jobs logged as `applied` are never applied to again.

## Resumes

`resumes/*.html` are the sources; start from `resumes/example.html`. `npm run resumes` turns them into Word files (`.docx`) and then PDFs with LibreOffice, a one-column layout that resume parsers (YC, Wellfound, Greenhouse and the rest) read reliably. `npm run setup` creates the Python venv it needs.

## Things to know

- LinkedIn's terms don't allow automated tools on its site and it can restrict accounts that use them. Auto Apply runs slowly, in your own browser, with you approving each application, but the risk is yours. Keep runs small.
- LinkedIn changes its page layout often. If a step stops working, the log and screenshot show where.
- On LinkedIn it only handles Easy Apply. Jobs that apply on a company's own site are logged as skipped with their link, so you can apply by hand (or add the company under `ats` if it uses Greenhouse, Lever or Ashby).
- Company forms sometimes show a CAPTCHA after Submit. Auto Apply never solves it; it waits up to 10 minutes for you to, in the window. Greenhouse may also email you a code, which you type in yourself.
- Wellfound, Work at a Startup and LinkedIn all ban automated tools in their terms. Company job boards are public forms, but go easy on any one company.

## No repeat applications

`data/applied.json` is a small local database of every job Auto Apply has sent an application to, including submits it couldn't confirm (a CAPTCHA or emailed code you may have finished yourself). Before each job Auto Apply checks it and skips the job if it matches an earlier one by:

- the same posting,
- the same link, or
- the same role at the same company, even on another site or under a slightly different company name ("Rubrik Job Board" and "Rubrik").

It was filled from the log the first time it ran, and Auto Apply adds to it after every confirmed send or other submit with no confirmation. A Greenhouse job still waiting for an email verification code is not added. `npm run applied` lists it. To allow a job again, delete its entry from the file. The folder is ignored by git.

