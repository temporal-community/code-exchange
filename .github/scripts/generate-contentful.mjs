/**
 * Generates a Contentful-ready markdown description for an approved Code Exchange submission.
 * Triggered when a reviewer checks the approval checkbox in ZiggyBot's evaluation comment.
 *
 * Posts the generated description as a new comment on the issue for the reviewer to copy
 * into Contentful.
 */

import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ISSUE_NUMBER = process.env.ISSUE_NUMBER;
const REPO = process.env.GITHUB_REPOSITORY;

function parseIssueBody(body) {
  const sections = {};
  const lines = (body || "").split("\n");
  let currentSection = null;
  let currentLines = [];
  for (const line of lines) {
    const headerMatch = line.match(/^###\s+(.+)$/);
    if (headerMatch) {
      if (currentSection) sections[currentSection] = currentLines.join("\n").trim();
      currentSection = headerMatch[1].trim();
      currentLines = [];
    } else if (currentSection) {
      currentLines.push(line);
    }
  }
  if (currentSection) sections[currentSection] = currentLines.join("\n").trim();
  return sections;
}

function extractGitHubUrl(text) {
  const match = (text || "").match(/https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)/);
  if (!match) return null;
  return { url: match[0], owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

async function fetchGitHub(path) {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function postComment(body) {
  const [owner, repo] = REPO.split("/");
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to post comment: ${res.status} ${text}`);
  }
}

async function main() {
  // Fetch the full issue to get its body
  const issue = await fetchGitHub(`/repos/${REPO}/issues/${ISSUE_NUMBER}`);
  if (!issue) throw new Error("Could not fetch issue data");

  const sections = parseIssueBody(issue.body);
  const projectLinkSection =
    sections["Project link"] || sections["Project Link"] || Object.values(sections)[0] || "";
  const parsed = extractGitHubUrl(projectLinkSection);
  if (!parsed) throw new Error("No GitHub URL found in issue");

  const { owner, repo } = parsed;

  const [repoData, readmeData] = await Promise.all([
    fetchGitHub(`/repos/${owner}/${repo}`),
    fetchGitHub(`/repos/${owner}/${repo}/readme`),
  ]);

  let readmeContent = "";
  if (readmeData?.content) {
    readmeContent = Buffer.from(readmeData.content, "base64").toString("utf-8");
    if (readmeContent.length > 10000) {
      readmeContent = readmeContent.slice(0, 10000) + "\n\n[... README truncated ...]";
    }
  }

  const shortDesc =
    sections["Short description (max 256 chars)"] || sections["Short description"] || "";
  const longDesc = sections["Long Description"] || sections["Long description"] || "";
  const language = sections["Language"] || "";
  const authors = sections["Author(s)"] || sections["Authors"] || "";

  const prompt = `You are writing the long description for an entry in Temporal's Code Exchange — a curated directory of community-built Temporal projects on temporal.io/code-exchange.

The description will be stored as markdown in Contentful and rendered on the website. Write it to be clear, accurate, and useful to developers evaluating whether this project is relevant to them. Avoid marketing language. Do not use superlatives. Be technical but approachable.

## Project Details

**Title:** ${issue.title.replace(/^\[Submission\]\s*/i, "").trim()}
**GitHub URL:** ${parsed.url}
**Language(s):** ${language}
**License:** ${repoData?.license?.name || "unknown"}
**Stars:** ${repoData?.stargazers_count ?? "unknown"}
**Submitter description (short):** ${shortDesc}
**Submitter description (long):** ${longDesc}
**Author(s):** ${authors}

**README:**
\`\`\`
${readmeContent || "No README available."}
\`\`\`

## Output Format

Write the Contentful markdown description using exactly this structure. Output only the markdown — no preamble, no explanation:

### What it does

[2–3 sentences describing what the project is and what problem it solves. Be specific.]

### How it uses Temporal

[2–3 sentences describing which Temporal concepts or patterns this project demonstrates or relies on — e.g. durable execution, activity retries, signals/queries, schedules, child workflows, sagas, etc. Be concrete.]

### Who it's for

[1–2 sentences describing the intended audience — e.g. developers building X, teams who need Y.]

### Getting started

[Brief summary of how to run or use the project, based on the README. If the README has clear setup steps, summarize them. If not, say so.]`;

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const description = message.content[0].text.trim();

  const comment =
    `## 📋 Contentful Description\n\n` +
    `Here's a ready-to-paste markdown description for this entry. Copy the block below into Contentful:\n\n` +
    `---\n\n` +
    description +
    `\n\n---\n\n` +
    `*Generated by ZiggyBot based on the project README and submission details.*`;

  await postComment(comment);
}

main().catch(async (err) => {
  console.error(err);
  await postComment(
    `## 📋 Contentful Description\n\n` +
      `ZiggyBot ran into an error generating the description. Please write it manually.\n\n` +
      `\`\`\`\n${err.message}\n\`\`\``
  ).catch(() => {});
  process.exit(1);
});
