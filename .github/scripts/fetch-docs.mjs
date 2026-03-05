/**
 * Fetches a curated set of Temporal documentation pages from the temporalio/documentation
 * repo, strips MDX/JSX noise, and writes a single consolidated docs-context.txt file
 * for use as prompt context in evaluate-submission.mjs.
 *
 * Run as part of the CI workflow; output is cached by docs repo commit SHA.
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const RAW_BASE =
  "https://raw.githubusercontent.com/temporalio/documentation/main";

// Curated pages — ordered from most to least foundational.
// Per-file char limits keep total prompt injection under ~10,000 chars.
const DOCS_PAGES = [
  {
    path: "docs/encyclopedia/temporal.mdx",
    title: "What is Temporal?",
    maxChars: 3000,
  },
  {
    path: "docs/encyclopedia/activities/activities.mdx",
    title: "Activities",
    maxChars: 2500,
  },
  {
    path: "docs/encyclopedia/detecting-activity-failures.mdx",
    title: "Activity Failures and Retries",
    maxChars: 2500,
  },
  {
    path: "docs/encyclopedia/child-workflows/child-workflows.mdx",
    title: "Child Workflows",
    maxChars: 2000,
  },
  {
    path: "docs/encyclopedia/workflow-message-passing/handling-messages.mdx",
    title: "Signals, Queries, and Updates",
    maxChars: 2000,
  },
];

function stripMdx(content) {
  return (
    content
      // Remove YAML frontmatter
      .replace(/^---[\s\S]*?---\n/, "")
      // Remove import statements
      .replace(/^import\s+.*?;\s*$/gm, "")
      // Remove self-closing JSX tags like <CaptionedImage ... />
      .replace(/<[A-Z][A-Za-z]*[^>]*\/>/g, "")
      // Remove opening JSX tags and their content through closing tags
      .replace(/<[A-Z][A-Za-z]*[^>]*>[\s\S]*?<\/[A-Z][A-Za-z]*>/g, "")
      // Remove Docusaurus admonition markers (:::note, :::tip, etc.) but keep content
      .replace(/^:::[\w-]+\s*$/gm, "")
      .replace(/^:::\s*$/gm, "")
      // Collapse 3+ blank lines to 2
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

async function fetchPage(path) {
  const url = `${RAW_BASE}/${path}`;
  try {
    const res = await fetch(url, {
      headers: GITHUB_TOKEN
        ? { Authorization: `Bearer ${GITHUB_TOKEN}` }
        : {},
    });
    if (!res.ok) {
      console.warn(`  Warning: ${path} returned ${res.status}`);
      return null;
    }
    return res.text();
  } catch (err) {
    console.warn(`  Warning: failed to fetch ${path}: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log("Fetching Temporal documentation pages...");
  const sections = [];

  for (const { path, title, maxChars } of DOCS_PAGES) {
    process.stdout.write(`  ${title}... `);
    const raw = await fetchPage(path);
    if (!raw) {
      console.log("skipped");
      continue;
    }
    let cleaned = stripMdx(raw);
    if (cleaned.length > maxChars) {
      cleaned = cleaned.slice(0, maxChars) + "\n[... truncated ...]";
    }
    sections.push(`### ${title}\n\n${cleaned}`);
    console.log(`${cleaned.length} chars`);
  }

  const output =
    `# Temporal Documentation Reference\n\n` +
    `The following is a condensed excerpt from the official Temporal documentation, ` +
    `for use as reference context when evaluating community submissions.\n\n` +
    sections.join("\n\n---\n\n");

  const outPath = join(__dirname, "docs-context.txt");
  writeFileSync(outPath, output, "utf-8");
  console.log(`\nWrote ${output.length} chars to docs-context.txt`);
}

main().catch((err) => {
  console.error("fetch-docs failed:", err.message);
  process.exit(1);
});
