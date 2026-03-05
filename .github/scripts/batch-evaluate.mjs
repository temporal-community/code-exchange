/**
 * Finds all open "code exchange submission" issues that don't yet have the
 * "ziggy reviewed" label and runs evaluate-submission.mjs on each one.
 */

import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;

async function fetchUnreviewedSubmissions() {
  const [owner, repo] = REPO.split("/");
  const results = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues` +
        `?state=open&labels=code+exchange+submission&per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const issues = await res.json();
    if (!issues.length) break;

    for (const issue of issues) {
      const alreadyReviewed = issue.labels.some(
        (l) => l.name === "ziggy reviewed"
      );
      if (!alreadyReviewed) results.push(issue);
    }

    if (issues.length < 100) break;
    page++;
  }

  return results;
}

async function main() {
  console.log("Finding open submissions without 'ziggy reviewed' label...");
  const issues = await fetchUnreviewedSubmissions();

  if (!issues.length) {
    console.log("All open submissions have already been reviewed. Nothing to do.");
    return;
  }

  console.log(`Found ${issues.length} issue(s) to evaluate:\n`);
  for (const issue of issues) {
    console.log(`  #${issue.number}: ${issue.title}`);
  }

  for (const issue of issues) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Evaluating #${issue.number}: ${issue.title}`);
    console.log("─".repeat(60));

    try {
      execFileSync("node", [join(__dirname, "evaluate-submission.mjs")], {
        env: {
          ...process.env,
          ISSUE_NUMBER: String(issue.number),
          ISSUE_TITLE: issue.title,
          ISSUE_BODY: issue.body || "",
        },
        stdio: "inherit",
      });
    } catch (err) {
      // Log and continue — don't abort the whole batch for one failure
      console.error(`Error evaluating #${issue.number}: ${err.message}`);
    }

    // Brief pause between evaluations to stay within API rate limits
    if (issues.indexOf(issue) < issues.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  console.log("\nBatch evaluation complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
