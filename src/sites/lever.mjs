// Lever company job boards (api.lever.co). Companies are listed in config.ats.lever.
import { applyOnForm, companyJobs, getJson } from "./ats.mjs";

export const name = "Lever";
export const id = "lever";

const list = async (company) => (await getJson(`https://api.lever.co/v0/postings/${company}?mode=json`)).map((j) => ({
  id: `lever:${company}:${j.id}`,
  url: j.hostedUrl,
  applyUrl: j.applyUrl ?? `${j.hostedUrl}/apply`,
  title: j.text,
  company,
  location: [j.categories?.location, ...(j.categories?.allLocations ?? []), j.workplaceType].filter(Boolean).join(", "),
  description: (j.descriptionPlain ?? "").slice(0, 5000),
}));

export const findJobs = () => companyJobs("lever", list);

export const apply = (page, job, resume, state) => applyOnForm(page, job, resume, state, {
  submit: /submit application/i,
  sent: /application (has been )?(submitted|received)|thank you for (applying|your application)/i,
});
