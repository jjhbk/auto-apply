// Greenhouse company job boards (boards-api.greenhouse.io). Companies are listed in config.ats.greenhouse.
import { applyOnForm, companyJobs, getJson, htmlToText } from "./ats.mjs";

export const name = "Greenhouse";
export const id = "greenhouse";

const list = async (board) => (await getJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs`)).jobs.map((j) => ({
  id: `greenhouse:${board}:${j.id}`,
  url: j.absolute_url,
  // The embedded form works for every board, including companies that host Greenhouse on their own careers site.
  applyUrl: `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${j.id}`,
  title: j.title,
  company: j.company_name ?? board,
  location: j.location?.name ?? "",
  load: async () => ({ description: htmlToText((await getJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${j.id}`)).content).slice(0, 5000) }),
}));

export const findJobs = () => companyJobs("greenhouse", list);

export const apply = (page, job, resume, state) => applyOnForm(page, job, resume, state, {
  submit: /submit application|^submit$/i,
  sent: /thank you for applying|application (has been |was )?(successfully )?(received|submitted)|we('ve| have) received your application/i,
});
