import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ISSUE_NUMBER = process.env.ISSUE_NUMBER;
const ISSUE_BODY = process.env.ISSUE_BODY;
const ISSUE_TITLE = process.env.ISSUE_TITLE;
const REPO = process.env.GITHUB_REPOSITORY; // "owner/repo" of the code-exchange repo
const DRY_RUN = process.env.DRY_RUN === "1";

const ACCEPTANCE_CRITERIA = `
1. Is the project genuinely useful to Temporal users?
2. Are the benefits of the project clearly explained in its documentation?
3. Is it released under an OSI Approved License? (MIT is recommended; Apache 2.0, BSD, etc. are also fine)
4. Is there a README, and do the instructions in the README appear to be functional and complete?
`.trim();

function parseIssueBody(body) {
  const sections = {};
  const lines = body.split("\n");
  let currentSection = null;
  let currentLines = [];

  for (const line of lines) {
    const headerMatch = line.match(/^###\s+(.+)$/);
    if (headerMatch) {
      if (currentSection) {
        sections[currentSection] = currentLines.join("\n").trim();
      }
      currentSection = headerMatch[1].trim();
      currentLines = [];
    } else if (currentSection) {
      currentLines.push(line);
    }
  }
  if (currentSection) {
    sections[currentSection] = currentLines.join("\n").trim();
  }
  return sections;
}

function extractGitHubUrl(text) {
  const match = text.match(/https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)/);
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

async function postComment(comment) {
  if (DRY_RUN) {
    console.log("\n=== DRY RUN: Comment that would be posted ===\n");
    console.log(comment);
    console.log("\n=== END ===\n");
    return;
  }
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
      body: JSON.stringify({ body: comment }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to post comment: ${res.status} ${text}`);
  }
}

async function main() {
  const sections = parseIssueBody(ISSUE_BODY || "");

  const projectLinkSection =
    sections["Project link"] ||
    sections["Project Link"] ||
    Object.values(sections)[0] ||
    "";
  const parsed = extractGitHubUrl(projectLinkSection);

  if (!parsed) {
    await postComment(
      `## 🤖 AI Pre-Evaluation\n\n` +
        `I couldn't find a valid GitHub URL in the **Project link** field. ` +
        `Please make sure the link is a full \`https://github.com/owner/repo\` URL and I'll take another look!\n\n` +
        `*ZiggyBot is an AI pre-screener based on Temporal's community mascot Ziggy. Final decisions are made by the community team.*`
    );
    return;
  }

  const { owner, repo } = parsed;

  const [repoData, readmeData] = await Promise.all([
    fetchGitHub(`/repos/${owner}/${repo}`),
    fetchGitHub(`/repos/${owner}/${repo}/readme`),
  ]);

  let readmeContent = "";
  if (readmeData?.content) {
    readmeContent = Buffer.from(readmeData.content, "base64").toString("utf-8");
    // Truncate to avoid hitting token limits — 8000 chars is plenty for evaluation
    if (readmeContent.length > 8000) {
      readmeContent = readmeContent.slice(0, 8000) + "\n\n[... README truncated ...]";
    }
  }

  const licenseInfo = repoData?.license
    ? `${repoData.license.name} (SPDX: ${repoData.license.spdx_id})`
    : "Not detected by GitHub";

  const shortDesc =
    sections["Short description (max 256 chars)"] ||
    sections["Short description"] ||
    "";
  const longDesc = sections["Long Description"] || sections["Long description"] || "";
  const language = sections["Language"] || "";

  const prompt = `You are ZiggyBot, an AI pre-screener for Temporal's Code Exchange — a curated showcase of community-built Temporal projects. You are based on Ziggy, Temporal's friendly tardigrade mascot. Your written notes (Notes, Suggested questions, Teaching moment) should be warm and encouraging in tone, as if written by an enthusiastic community member, while still being honest and technically precise. Evaluate the submission against the acceptance criteria and provide a structured review.

## Submission Details

**Issue title:** ${ISSUE_TITLE}
**Project URL:** ${parsed.url}
**Language(s):** ${language}
**Short description:** ${shortDesc}
**Long description:** ${longDesc}

## Fetched Repository Data

**GitHub repo description:** ${repoData?.description || "none"}
**License:** ${licenseInfo}
**Is fork:** ${repoData?.fork ?? "unknown"}
**Stars:** ${repoData?.stargazers_count ?? "unknown"}
**README content:**
\`\`\`
${readmeContent || "No README found or README could not be fetched."}
\`\`\`

## Acceptance Criteria

${ACCEPTANCE_CRITERIA}

## Your Task

Provide a structured evaluation in the following exact markdown format. Do not add any text before or after this block:

---

| Criterion | Assessment |
|-----------|------------|
| Useful to Temporal users | [✅ Yes / ⚠️ Unclear / ❌ No] — one sentence explanation |
| Benefits clearly explained | [✅ Yes / ⚠️ Unclear / ❌ No] — one sentence explanation |
| OSI Approved License | [✅ Yes / ⚠️ Unclear / ❌ No] — one sentence explanation |
| README with working instructions | [✅ Yes / ⚠️ Unclear / ❌ No] — one sentence explanation |

**Overall:** [Looks good ✅ / Needs review ⚠️ / Does not meet criteria ❌]

**Notes:**
- [Any notable observations about the project quality, scope, or relevance]

**Suggested questions for submitter:**
- [Questions the community team might want to ask, or "None" if the submission is clear]

**Teaching moment:**
> [Identify the single most interesting Temporal-specific pattern, concept, or technique demonstrated in this project — based on the README and description. Quote or paraphrase a brief, concrete example (a few lines or a description of a pattern). Then write 1-2 sentences explaining why it's a good teaching example for Temporal users. If no clear Temporal-specific pattern is evident from the available information, say so honestly.]

---`;

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const evaluation = message.content[0].text.trim();

  const comment =
    `## Hi, I'm ZiggyBot! 🤖 Here's my pre-evaluation of this submission:\n\n` +
    evaluation +
    `\n\n*ZiggyBot is an AI pre-screener based on Temporal's community mascot Ziggy. Final decisions are made by the community team.*`;

  await postComment(comment);
}

main().catch(async (err) => {
  console.error(err);
  await postComment(
    `## Hi, I'm ZiggyBot! 🤖\n\n` +
      `I ran into an error while trying to evaluate this submission — the community team will need to review it manually.\n\n` +
      `\`\`\`\n${err.message}\n\`\`\`\n\n` +
      `*ZiggyBot is an AI pre-screener based on Temporal's community mascot Ziggy. Final decisions are made by the community team.*`
  ).catch(() => {});
  process.exit(1);
});
