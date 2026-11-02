// Opens the browser so you can sign in to a site once: npm run signin -- --site=wellfound
// The sign-in stays in .browser-profile/ for later runs.
import { arg, openBrowser, profileDir, say } from "./core.mjs";
import { loadSites } from "./sites/index.mjs";

const sites = (await loadSites((arg("site") ?? "linkedin").split(","))).filter((s) => s.signIn);
const { context, page } = await openBrowser();
try {
  for (const site of sites) {
    await site.signIn(page);
    // Give the site a moment to finish setting its cookies before the profile is written to disk.
    await page.waitForTimeout(5000);
  }
  say(`Sign-in saved in ${profileDir}. Run "npm run dry-run" next.`);
} catch (err) {
  say(/has been closed/.test(err.message) ? "The browser window was closed before sign-in finished. Run npm run signin again." : err.message);
  process.exitCode = 1;
}
await context.close().catch(() => {});
