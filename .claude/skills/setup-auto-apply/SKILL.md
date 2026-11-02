---
name: setup-auto-apply
description: Set up Auto Apply for a new person on their own machine - install it, build their config and resumes from their own details, sign in to the job sites, and run a dry run. Use when someone opens this project for the first time, asks to set it up or get started, or has no config/profile.json yet.
---

# Set up Auto Apply

You are helping one person get Auto Apply working on their own computer, for their own job search. Work through the steps in order. Ask for what you need in plain language, a few questions at a time, and fill in everything you can from their resume so they type as little as possible.

## Rules that hold throughout

- **Their passwords are theirs.** They sign in to each site themselves in the browser window. Never ask for, type, read or store a password.
- **CAPTCHAs and emailed codes are theirs.** Auto Apply waits for the person to solve them. Never solve, bypass or automate them, and never add stealth or bot-evasion packages.
- **Only true answers.** The config holds facts about the person. Never write an answer that misstates their work authorization, visa, location, experience or education, even if they ask; explain why and offer the truthful version.
- **Their data stays local.** `config/profile.json`, `config/long-answers.md`, `resumes/*` (except the template), `.env`, `logs/`, `data/` and `.browser-profile/` are git-ignored. Keep it that way.
- **Never import from outside this folder.**

## 1. Install

Check what's there, then install what's missing:

- Node 20 or newer (`node --version`).
- Python 3 and LibreOffice (`libreoffice --version`), used to build resumes that job-site parsers read well. On Debian/Ubuntu: `sudo apt install libreoffice-writer`; on macOS: `brew install --cask libreoffice`. Ask before running anything with sudo.
- Then run `npm run setup` (npm packages, Playwright's Chromium, a Python venv with python-docx).

## 2. Their details

Ask for their resume (a PDF or DOCX path, or pasted text) and read it. From it, draft as much as you can, then ask only for what's missing:

- Name, email, phone, city, and links (LinkedIn, website, GitHub, Wellfound).
- **Roles** they want (e.g. "AI Engineer") and **locations** (cities, countries, remote).
- **Work authorization**: where they may work, and whether a new employer would need to sponsor a visa. Write it as a plain sentence in `profile.workAuthorization`; Auto Apply answers sponsorship questions from it, per job country.
- Notice period, current and expected pay (only if they want those answered; an empty answer lets the model draft or leaves it), willingness to relocate.
- Each job's company, title, start and end month (`YYYY-MM`, `present` for current), and city; education with dates.
- Which sites to use: `wellfound`, `yc` (Work at a Startup), `greenhouse`, `lever`, `ashby`, `workday`, `linkedin`. Suggest starting with Wellfound, Work at a Startup, Greenhouse and Ashby.
- Companies to watch on Greenhouse, Lever and Ashby: the board name is the part after the host in their careers URL (`job-boards.greenhouse.io/<board>`, `jobs.lever.co/<board>`, `jobs.ashbyhq.com/<board>`). Check each with its public feed before adding it:
  `https://boards-api.greenhouse.io/v1/boards/<board>/jobs`, `https://api.lever.co/v0/postings/<board>?mode=json`, `https://api.ashbyhq.com/posting-api/job-board/<board>`.

## 3. Write the config

Copy `config/profile.example.json` to `config/profile.json` and fill it in. Notes:

- `filters.titleMustInclude`: lowercase phrases, whole words, that a job title must contain (e.g. "ai engineer", "forward deployed"). `titleMustNotInclude` drops titles like "intern", "manager".
- `answers`: `question` is a case-insensitive regex matched against a form field's label; `answer` is what to put; `textAnswer` is used when the same question is a text box instead of buttons. An empty `answer` means "let the model draft it from the resume, or leave it".
- `apply.pauseForApproval`: keep `true` for the first live run so they approve each submit in the terminal.
- Optional: `config/long-answers.md` with their own short bio and "what I'm looking for" text, for pasting into site profiles.

## 4. Resumes

Make one resume per kind of role, from their resume's real content only:

- Copy `resumes/example.html` to `resumes/<role>.html` (e.g. `resumes/ai-engineer.html`) and fill it in. Keep the structure: each job is a `<div class="role">` with the title, a `span.org` and a `span.dates`, then bullets.
- List each file in `config.resumes` with `useWhenTitleMatches`; the last entry is the default.
- Run `npm run resumes` to build `.docx` and `.pdf`. Open the PDF (or read it back) and check nothing is missing.

## 5. Drafting answers (optional but recommended)

Auto Apply drafts answers to open questions with a model. Ask the person to put their own `OPENAI_API_KEY=...` or `ANTHROPIC_API_KEY=...` in `.env` themselves; never print the key back. Without a key, unanswered required questions stop that job.

## 6. Sign in

Run `npm run signin -- --site=<sites>`. A Chromium window opens; the person signs in to each site. The browser profile in `.browser-profile/` keeps them signed in. Work at a Startup and Wellfound also need a profile on the site with their resume uploaded: `npm run open -- --site=yc` leaves a window open with no time limit while they do that.

## 7. Dry run, then live

- `npm run dry-run -- --limit=1` fills one form per site and sends nothing. Read the terminal and the screenshots in `logs/screens/` with them. Fix wrong answers by adding `answers` entries, and re-run.
- First live run: `npm start -- --limit=2` with approval on. When they're happy, they can set `pauseForApproval` to `false`.
- `npm run log` shows every job looked at; `npm run applied` lists every application sent. Auto Apply never applies to the same job twice and waits a few minutes between sends on each site.

Finish by telling them, in a few lines, which sites are set up, what a run looks like, and that Greenhouse may ask them for a CAPTCHA and an emailed code.
