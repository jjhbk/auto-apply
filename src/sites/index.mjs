// Every site Auto Apply can apply on. Each module exports: id, name, signIn(page)?, findJobs(page) (async generator), apply(page, job, resume, state).
const SITES = {
  linkedin: () => import("./linkedin.mjs"),
  wellfound: () => import("./wellfound.mjs"),
  yc: () => import("./yc.mjs"),
  greenhouse: () => import("./greenhouse.mjs"),
  lever: () => import("./lever.mjs"),
  ashby: () => import("./ashby.mjs"),
  workday: () => import("./workday.mjs"),
};

export async function loadSites(ids) {
  return Promise.all(ids.map(async (id) => {
    if (!SITES[id]) throw new Error(`Unknown site "${id}". Known: ${Object.keys(SITES).join(", ")}`);
    return SITES[id]();
  }));
}

export const siteIds = () => Object.keys(SITES);
