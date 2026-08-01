import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const docsRoot = path.join(repositoryRoot, "docs");
const manifestPath = path.join(docsRoot, "navigation.json");
const errors = [];

function report(location, message) {
  errors.push(`${location}: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDocPath(value, location) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    (value.length > 1 && value.endsWith("/"))
  ) {
    report(
      location,
      "expected an absolute document path without a trailing slash",
    );
    return false;
  }
  return true;
}

function validatePresentation(value, location, requireLabel) {
  if (!isRecord(value)) {
    report(location, "expected an object");
    return;
  }

  if (
    requireLabel &&
    (typeof value.label !== "string" || value.label.length === 0)
  ) {
    report(`${location}.label`, "expected a non-empty string");
  } else if (value.label !== undefined && typeof value.label !== "string") {
    report(`${location}.label`, "expected a string");
  }

  for (const field of ["image", "description"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      report(`${location}.${field}`, "expected a string");
    }
  }
  if (value.hide !== undefined && typeof value.hide !== "boolean") {
    report(`${location}.hide`, "expected a boolean");
  }
}

async function documentFiles(directory, documents = new Map()) {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = new Set(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  const hasMetadata = names.has("metadata.json");
  const hasPage = names.has("page.svx");

  if (hasMetadata || hasPage) {
    const docPath =
      "/" +
      path
        .relative(docsRoot, directory)
        .split(path.sep)
        .join("/");
    documents.set(docPath, { hasMetadata, hasPage });

    if (!hasMetadata) report(docPath, "page.svx is missing metadata.json");
    if (!hasPage) report(docPath, "metadata.json is missing page.svx");
    if (hasMetadata) {
      try {
        JSON.parse(
          await readFile(path.join(directory, "metadata.json"), "utf8"),
        );
      } catch (error) {
        report(
          `${docPath}/metadata.json`,
          `contains invalid JSON: ${error.message}`,
        );
      }
    }

  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await documentFiles(path.join(directory, entry.name), documents);
    }
  }
  return documents;
}

function referencePath(value, docs, location) {
  let docPath;
  if (typeof value === "string") {
    docPath = value;
  } else if (isRecord(value)) {
    docPath = value.path;
    validatePresentation(value, location, false);
  } else {
    report(location, "expected a document path or reference object");
    return;
  }

  if (!validDocPath(docPath, `${location}.path`)) return;
  if (!docs.has(docPath)) {
    report(location, `references unknown document ${docPath}`);
  }
}

const files = await documentFiles(docsRoot);
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  report("docs/navigation.json", `contains invalid JSON: ${error.message}`);
}

const docs = new Set();
if (manifest) {
  if (!isRecord(manifest)) {
    report("manifest", "expected an object");
  } else {
    if (manifest.schemaVersion !== 1) {
      report("manifest.schemaVersion", "expected version 1");
    }

    if (!isRecord(manifest.docs)) {
      report("manifest.docs", "expected an object");
    } else {
      for (const [docPath, info] of Object.entries(manifest.docs)) {
        const location = `manifest.docs[${JSON.stringify(docPath)}]`;
        if (validDocPath(docPath, location)) docs.add(docPath);
        validatePresentation(info, location, true);
      }
    }

    if (!isRecord(manifest.navigation)) {
      report("manifest.navigation", "expected an object");
    } else {
      for (const [navigationPath, entries] of Object.entries(
        manifest.navigation,
      )) {
        const location =
          `manifest.navigation[${JSON.stringify(navigationPath)}]`;
        validDocPath(navigationPath, location);
        if (!Array.isArray(entries)) {
          report(location, "expected an array");
          continue;
        }

        entries.forEach((entry, entryIndex) => {
          const entryLocation = `${location}[${entryIndex}]`;
          if (isRecord(entry) && "docs" in entry) {
            validatePresentation(entry, entryLocation, true);
            if (!Array.isArray(entry.docs)) {
              report(`${entryLocation}.docs`, "expected an array");
              return;
            }
            entry.docs.forEach((reference, referenceIndex) =>
              referencePath(
                reference,
                docs,
                `${entryLocation}.docs[${referenceIndex}]`,
              ),
            );
            return;
          }
          referencePath(entry, docs, entryLocation);
        });
      }
    }

    for (const navigationPath of ["/reference", "/learn"]) {
      if (!Array.isArray(manifest.navigation?.[navigationPath])) {
        report(
          "manifest.navigation",
          `missing required navigation ${navigationPath}`,
        );
      }
    }
  }
}

for (const [docPath, pair] of files) {
  if (pair.hasMetadata && pair.hasPage && !docs.has(docPath)) {
    report(docPath, "document is missing from manifest.docs");
  }
}
for (const docPath of docs) {
  const pair = files.get(docPath);
  if (!pair?.hasMetadata || !pair?.hasPage) {
    report(
      docPath,
      "manifest document is missing its metadata.json/page.svx pair",
    );
  }
}

if (errors.length > 0) {
  console.error(errors.map((message) => `- ${message}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${docs.size} documents and ${
      Object.keys(manifest.navigation).length
    } navigation entries.`,
  );
}
