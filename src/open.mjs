// Opens the browser on a site with your saved sign-ins and leaves it open until you close the window,
// for setting up a profile by hand: npm run open -- --site=yc
import { arg, openBrowser, say } from "./core.mjs";

const URLS = {
  linkedin: "https://www.linkedin.com/in/",
  wellfound: "https://wellfound.com/profile/edit/overview",
  yc: "https://www.workatastartup.com/application",
};
const site = arg("site") ?? "linkedin";
const { context, page } = await openBrowser();
await page.goto(arg("url") ?? URLS[site] ?? site, { waitUntil: "domcontentloaded" }).catch(() => {});
say("The window stays open with no time limit. Close it when you're done; everything is saved in the browser profile.");
await new Promise((done) => context.on("close", done));
