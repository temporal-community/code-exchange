import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

async function ensureLabelExists(owner, repo, name, color, description) {
  // Try to create — a 422 means it already exists, which is fine.
  await fetch(`https://api.github.com/repos/${owner}/${repo}/labels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, color, description }),
  });
}

async function addLabel(owner, repo, issueNumber, label) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ labels: [label] }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to add label: ${res.status} ${text}`);
  }
}

// Hidden marker (invisible in rendered markdown) so reruns update ZiggyBot's
// existing evaluation comment in place instead of posting a duplicate.
const COMMENT_MARKER = "<!-- ziggybot-eval -->";

async function findExistingComment(owner, repo) {
  let page = 1;
  while (true) {
    const comments = await fetchGitHub(
      `/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}/comments?per_page=100&page=${page}`
    );
    if (!comments || !comments.length) return null;
    const hit = comments.find((c) => c.body && c.body.includes(COMMENT_MARKER));
    if (hit) return hit.id;
    if (comments.length < 100) return null;
    page++;
  }
}

async function postComment(comment) {
  const body = `${COMMENT_MARKER}\n${comment}`;
  if (DRY_RUN) {
    console.log("\n=== DRY RUN: Comment that would be posted ===\n");
    console.log(body);
    console.log("\n=== END ===\n");
    return;
  }
  const [owner, repo] = REPO.split("/");
  // Upsert: update the existing ZiggyBot comment if present, else create one.
  const existingId = await findExistingComment(owner, repo);
  const url = existingId
    ? `https://api.github.com/repos/${owner}/${repo}/issues/comments/${existingId}`
    : `https://api.github.com/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}/comments`;
  const res = await fetch(url, {
    method: existingId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Failed to ${existingId ? "update" : "post"} comment: ${res.status} ${text}`
    );
  }
}

// Score a file path for likelihood of containing interesting Temporal code.
// Returns 0 for files that should be skipped entirely.
function scoreCodeFile(path, size) {
  const lower = path.toLowerCase();
  const filename = lower.split("/").pop();
  const ext = filename.split(".").pop();

  const CODE_EXTS = new Set(["go", "ts", "js", "mjs", "py", "java", "cs", "rb", "php", "swift", "kt"]);
  if (!CODE_EXTS.has(ext)) return 0;
  if (size > 60000) return 0; // skip huge files

  // Skip test files
  if (/_test\.|\.test\.|\.spec\.|^test_/.test(filename)) return 0;

  let score = 1;
  if (lower.includes("workflow")) score += 10;
  if (lower.includes("activit")) score += 8; // activity / activities
  if (lower.includes("saga")) score += 7;
  if (lower.includes("signal") || lower.includes("query")) score += 5;
  if (lower.includes("schedule")) score += 4;

  // Bonus for being inside a relevant directory
  const parts = lower.split("/");
  if (parts.some((p) => ["workflow", "workflows", "activity", "activities"].includes(p))) score += 3;

  return score;
}

async function fetchRepoTree(owner, repo) {
  const treeData = await fetchGitHub(
    `/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`
  );
  return treeData?.tree || [];
}

// Look for a top-level license file in the repo tree. GitHub's license
// classifier reports NOASSERTION for valid licenses it can't match, so we
// detect the file ourselves and let the model read it rather than guessing.
function detectLicenseFile(tree) {
  const match = tree.find((item) => {
    if (item.type !== "blob" || item.path.includes("/")) return false; // top-level only
    const name = item.path.toLowerCase();
    return /^(licen[sc]e|copying|unlicense)(\..+)?$/.test(name);
  });
  return match?.path || null;
}

async function fetchFileContent(owner, repo, path, maxChars) {
  const fileData = await fetchGitHub(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`
  );
  if (!fileData?.content) return null;
  let content = Buffer.from(fileData.content, "base64").toString("utf-8");
  if (content.length > maxChars) {
    content = content.slice(0, maxChars) + "\n// [... truncated ...]";
  }
  return content;
}

async function fetchCodeFiles(owner, repo, tree) {
  const candidates = tree
    .filter((item) => item.type === "blob")
    .map((item) => ({ path: item.path, score: scoreCodeFile(item.path, item.size) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3); // fetch at most 3 files to stay within token budget

  const results = [];
  for (const { path } of candidates) {
    const content = await fetchFileContent(owner, repo, path, 2500);
    if (content === null) continue;
    results.push({ path, content });
  }
  return results;
}

function loadDocsContext() {
  try {
    return readFileSync(join(__dirname, "docs-context.txt"), "utf-8");
  } catch {
    return null;
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
      `## ZiggyBot — automated pre-evaluation\n\n` +
        `No valid GitHub URL was found in the **Project link** field. ` +
        `Provide a full \`https://github.com/owner/repo\` URL and re-trigger the review.\n\n` +
        `---\n*Automated AI pre-screen by ZiggyBot. Final decisions are made by the community team.*`
    );
    return;
  }

  const { owner, repo } = parsed;

  const [repoData, readmeData, tree] = await Promise.all([
    fetchGitHub(`/repos/${owner}/${repo}`),
    fetchGitHub(`/repos/${owner}/${repo}/readme`),
    fetchRepoTree(owner, repo),
  ]);

  const codeFiles = await fetchCodeFiles(owner, repo, tree);
  const defaultBranch = repoData?.default_branch || "main";

  let readmeContent = "";
  let readmeTruncated = false;
  if (readmeData?.content) {
    readmeContent = Buffer.from(readmeData.content, "base64").toString("utf-8");
    // Truncate only to stay within token limits. This is a tooling limit, not
    // a deficiency in the submission — the prompt tells the model not to
    // penalize the submitter for the omitted tail.
    if (readmeContent.length > 16000) {
      readmeContent = readmeContent.slice(0, 16000) + "\n\n[... README truncated for review ...]";
      readmeTruncated = true;
    }
  }

  // Resolve the license. GitHub's classifier reports NOASSERTION for licenses
  // it can't match, so fall back to detecting a license file in the tree and
  // reading it, rather than defaulting to "unclear".
  const spdx = repoData?.license?.spdx_id;
  const hasClassifiedLicense = spdx && spdx !== "NOASSERTION";
  const licenseFilePath = detectLicenseFile(tree);
  let licenseInfo;
  let licenseFileContent = "";
  if (hasClassifiedLicense) {
    licenseInfo = `${repoData.license.name} (SPDX: ${spdx})`;
  } else if (licenseFilePath) {
    licenseInfo = `GitHub could not auto-classify it, but a license file exists at "${licenseFilePath}" — its contents are provided below so you can identify the license yourself.`;
    licenseFileContent = (await fetchFileContent(owner, repo, licenseFilePath, 1500)) || "";
  } else {
    licenseInfo = "No license file detected anywhere in the repository.";
  }

  const shortDesc =
    sections["Short description (max 256 chars)"] ||
    sections["Short description"] ||
    "";
  const longDesc = sections["Long Description"] || sections["Long description"] || "";
  const language = sections["Language"] || "";

  const docsContext = loadDocsContext();

  const prompt = `You are ZiggyBot, an automated pre-screener for Temporal's Code Exchange — a curated showcase of community-built Temporal projects. Your output is a triage note read by the community-review team and by the submitter. Write in a neutral, factual, technical tone, like an internal code-review note. No mascot persona, no greetings, no emoji, no exclamation marks, no superlatives, and no filler interjections ("beautifully crafted", "chef's kiss", "showstopper", "delightful", "elegant", "love the…"). State strengths and weaknesses as plain, specific observations. Be concise. Evaluate the submission against the acceptance criteria and provide a structured review.

## Submission Details

**Issue title:** ${ISSUE_TITLE}
**Project URL:** ${parsed.url}
**Language(s):** ${language}
**Short description:** ${shortDesc}
**Long description:** ${longDesc}

## Fetched Repository Data

**GitHub repo description:** ${repoData?.description || "none"}
**License:** ${licenseInfo}${licenseFileContent ? `
**License file contents:**
\`\`\`
${licenseFileContent}
\`\`\`` : ""}
**Is fork:** ${repoData?.fork ?? "unknown"}
**Stars:** ${repoData?.stargazers_count ?? "unknown"}
**README content:**${readmeTruncated ? " (truncated by our tooling for length — evaluate what's present and do NOT ask the submitter to supply the omitted tail)" : ""}
\`\`\`
${readmeContent || "No README found or README could not be fetched."}
\`\`\`
${codeFiles.length > 0 ? `
## Source Code Files

The following files were identified as likely containing core Temporal logic:

${codeFiles.map(({ path, content }) => `**\`${path}\`**\n\`\`\`\n${content}\n\`\`\``).join("\n\n")}
` : ""}
${docsContext ? `## Temporal Reference\n\n${docsContext}\n\n` : ""}## Acceptance Criteria

${ACCEPTANCE_CRITERIA}

## Your Task

When assessing the license, identify it from the license file contents above if GitHub failed to classify it: a present, identifiable OSI-approved license is ✅ even when GitHub reports NOASSERTION. Use ❌ only when no license file exists at all, and ⚠️ only when a file exists but its license genuinely cannot be determined.

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

**Notable Temporal pattern:**
> [Name the single most representative Temporal-specific pattern, concept, or technique this project demonstrates. State it in 1-2 plain, factual sentences — what the pattern is and why it is representative. No praise or enthusiasm. If no clear Temporal-specific pattern is evident, say so.]
> If the pattern comes from one of the source code files above, end with a code reference on its own line in exactly this format (no deviations): [code-ref: path/to/file.go L42-L67]

---`;

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const rawEvaluation = message.content[0].text.trim();

  // Convert [code-ref: path/to/file.go L42-L67] into a clickable GitHub link
  const evaluation = rawEvaluation.replace(
    /\[code-ref:\s*(\S+)\s+(L\d+(?:-L?\d+)?)\]/g,
    (_, filePath, lines) => {
      const anchor = lines.replace(/^(L\d+)-L?(\d+)$/, "$1-L$2");
      return `[View in source ↗](https://github.com/${owner}/${repo}/blob/${defaultBranch}/${filePath}#${anchor})`;
    }
  );

  const comment =
    `## ZiggyBot — automated pre-evaluation\n\n` +
    evaluation +
    `\n\n---\n*Automated AI pre-screen by ZiggyBot. Final decisions are made by the community team.*` +
    `\n\n**Reviewer:** Check the box below to generate a Contentful-ready long description for this submission.\n- [ ] Generate long description if needed`;

  await postComment(comment);

  if (!DRY_RUN) {
    const [repoOwner, repoName] = REPO.split("/");
    await ensureLabelExists(
      repoOwner, repoName,
      "ziggy reviewed", "7B61FF",
      "Pre-screened by ZiggyBot"
    );
    await addLabel(repoOwner, repoName, ISSUE_NUMBER, "ziggy reviewed");
  }
}

main().catch(async (err) => {
  console.error(err);
  await postComment(
    `## ZiggyBot — automated pre-evaluation\n\n` +
      `An error occurred during automated evaluation; the community team will need to review this submission manually.\n\n` +
      `\`\`\`\n${err.message}\n\`\`\`\n\n` +
      `---\n*Automated AI pre-screen by ZiggyBot. Final decisions are made by the community team.*`
  ).catch(() => {});
  process.exit(1);
});
