// Ashby company job boards (api.ashbyhq.com). Companies are listed in config.ats.ashby.
import { applyOnForm, companyJobs, getJson } from "./ats.mjs";

export const name = "Ashby";
export const id = "ashby";

const list = async (board) => (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${board}`)).jobs
  .filter((j) => j.isListed !== false)
  .map((j) => ({
    id: `ashby:${board}:${j.id}`,
    url: j.jobUrl,
    applyUrl: j.applyUrl ?? `${j.jobUrl}/application`,
    title: j.title,
    company: board,
    location: [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location), j.isRemote ? "Remote" : ""].filter(Boolean).join(", "),
    description: (j.descriptionPlain ?? "").slice(0, 5000),
  }));

export const findJobs = () => companyJobs("ashby", list);

export const apply = (page, job, resume, state) => applyOnForm(page, job, resume, state, {
  submit: /submit application/i,
  sent: /application (was |has been )?(successfully )?(submitted|received)|thank(s| you) for (applying|your application|your interest)/i,
});
