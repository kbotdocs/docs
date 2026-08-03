import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const docsRoot = path.join(repositoryRoot, "docs");
const compatibilityRoot = path.join(repositoryRoot, "compatibility");
const errors = [];
const compatibilityFiles = new Map();
const documentPaths = new Set();
const allowedApps = new Set([
  "msgBot",
  "autoReplyBot",
  "starLight",
  "irispy_client",
  "irisPy2",
  "irisTs",
  "irisNode",
  "irisEx",
  "irisRb",
]);
const allowedCompatibilityStatuses = new Set([
  "full_support",
  "partial_support",
  "no_support",
]);
let compatibilityEntryCount = 0;
let documentReferenceCount = 0;

function report(location, message) {
  errors.push(`${location}: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayPath(filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

function normalizeDataPath(value) {
  return value
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.json$/, "");
}

function unexpectedKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) report(`${location}.${key}`, "unexpected field");
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
    }),
  );
  return files.flat();
}

async function parseJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    report(displayPath(filePath), `contains invalid JSON: ${error.message}`);
    return undefined;
  }
}

function validateFeatureStatus(value, location) {
  if (!isRecord(value)) {
    report(location, "expected an object");
    return;
  }

  const fields = new Set(["deprecated", "experimental", "nonStandard"]);
  unexpectedKeys(value, fields, location);
  for (const field of fields) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      report(`${location}.${field}`, "expected a boolean");
    }
  }
}

function validateVersion(value, location) {
  if (typeof value === "string") return;
  if (!isRecord(value)) {
    report(location, "expected a string or version range object");
    return;
  }

  unexpectedKeys(value, new Set(["start", "last"]), location);
  if (typeof value.start !== "string") {
    report(`${location}.start`, "expected a string");
  }
  if (value.last !== undefined && typeof value.last !== "string") {
    report(`${location}.last`, "expected a string");
  }
}

function validateSupportHistory(value, location) {
  if (!isRecord(value)) {
    report(location, "expected an object");
    return;
  }

  unexpectedKeys(
    value,
    new Set(["status", "detailedStatus", "version", "description"]),
    location,
  );
  if (!allowedCompatibilityStatuses.has(value.status)) {
    report(`${location}.status`, "expected a supported compatibility status");
  }
  validateVersion(value.version, `${location}.version`);

  if (value.detailedStatus !== undefined) {
    if (!isRecord(value.detailedStatus)) {
      report(`${location}.detailedStatus`, "expected an object");
    } else {
      const fields = new Set(["bug", "seeImpl"]);
      unexpectedKeys(value.detailedStatus, fields, `${location}.detailedStatus`);
      for (const field of fields) {
        if (
          value.detailedStatus[field] !== undefined &&
          typeof value.detailedStatus[field] !== "boolean"
        ) {
          report(`${location}.detailedStatus.${field}`, "expected a boolean");
        }
      }
    }
  }

  if (
    value.description !== undefined &&
    typeof value.description !== "string" &&
    !(
      Array.isArray(value.description) &&
      value.description.every((item) => typeof item === "string")
    )
  ) {
    report(`${location}.description`, "expected a string or string array");
  }
}

function validateCompatibilityEntry(value, location) {
  if (typeof value === "string") {
    if (value.trim().length === 0) report(location, "expected a reference");
    return;
  }
  if (!isRecord(value)) {
    report(location, "expected an object or reference string");
    return;
  }

  unexpectedKeys(
    value,
    new Set(["feature", "url", "status", "support"]),
    location,
  );
  if (typeof value.feature !== "string" || value.feature.length === 0) {
    report(`${location}.feature`, "expected a non-empty string");
  }
  if (value.url !== undefined && typeof value.url !== "string") {
    report(`${location}.url`, "expected a string");
  } else if (
    typeof value.url === "string" &&
    (!value.url.startsWith("/") ||
      (value.url.length > 1 && value.url.endsWith("/")))
  ) {
    report(`${location}.url`, "expected an absolute document path");
  }
  validateFeatureStatus(value.status, `${location}.status`);

  if (!isRecord(value.support)) {
    report(`${location}.support`, "expected an object");
    return;
  }
  for (const [app, history] of Object.entries(value.support)) {
    const appLocation = `${location}.support.${app}`;
    if (!allowedApps.has(app)) report(appLocation, "unknown app identifier");
    if (!Array.isArray(history)) {
      report(appLocation, "expected an array");
      continue;
    }
    history.forEach((item, index) =>
      validateSupportHistory(item, `${appLocation}[${index}]`),
    );
  }
}

function parseReference(reference, fallbackFeature) {
  const hashIndex = reference.indexOf("#");
  const data = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
  const feature =
    hashIndex === -1
      ? fallbackFeature
      : reference.slice(hashIndex + 1).trim() || fallbackFeature;
  return { dataPath: normalizeDataPath(data), feature };
}

function resolveCompatibilityEntry(
  dataPath,
  feature,
  location,
  visited = new Set(),
) {
  const normalizedPath = normalizeDataPath(dataPath);
  const identity = `${normalizedPath}#${feature}`;
  if (visited.has(identity)) {
    report(location, `contains a circular reference through ${identity}`);
    return undefined;
  }

  const data = compatibilityFiles.get(normalizedPath);
  if (!data) {
    report(location, `references missing compatibility data ${normalizedPath}`);
    return undefined;
  }

  let value = data[feature];
  if (value === undefined) {
    const values = Object.values(data);
    if (values.length === 1) value = values[0];
  }
  if (value === undefined) {
    report(location, `references missing feature ${identity}`);
    return undefined;
  }
  if (typeof value !== "string") return isRecord(value) ? value : undefined;

  const target = parseReference(value, feature);
  if (!target.dataPath) {
    report(location, "contains a reference without a data path");
    return undefined;
  }
  const nextVisited = new Set(visited);
  nextVisited.add(identity);
  return resolveCompatibilityEntry(
    target.dataPath,
    target.feature,
    location,
    nextVisited,
  );
}

function validateResolvedDocumentUrl(value, location) {
  if (
    value &&
    typeof value.url === "string" &&
    !documentPaths.has(value.url)
  ) {
    report(`${location}.url`, `references unknown document ${value.url}`);
  }
}

const compatibilityFilePaths = (await listFiles(compatibilityRoot))
  .filter((filePath) => filePath.endsWith(".json"))
  .sort();
for (const filePath of compatibilityFilePaths) {
  const dataPath = path
    .relative(compatibilityRoot, filePath)
    .slice(0, -".json".length)
    .split(path.sep)
    .join("/");
  const data = await parseJson(filePath);
  if (!isRecord(data)) {
    if (data !== undefined) report(displayPath(filePath), "expected an object");
    continue;
  }
  compatibilityFiles.set(dataPath, data);
  for (const [feature, value] of Object.entries(data)) {
    compatibilityEntryCount += 1;
    validateCompatibilityEntry(
      value,
      `${displayPath(filePath)}[${JSON.stringify(feature)}]`,
    );
  }
}

const docsFiles = await listFiles(docsRoot);
for (const filePath of docsFiles) {
  if (path.basename(filePath) !== "page.svx") continue;
  const docPath =
    "/" +
    path.relative(docsRoot, path.dirname(filePath)).split(path.sep).join("/");
  documentPaths.add(docPath);
}

for (const [dataPath, data] of compatibilityFiles) {
  for (const [feature, value] of Object.entries(data)) {
    const location = `compatibility/${dataPath}.json[${JSON.stringify(feature)}]`;
    if (typeof value === "string") {
      resolveCompatibilityEntry(dataPath, feature, location);
    }
  }
}

for (const filePath of docsFiles) {
  const filename = path.basename(filePath);
  if (filename === "metadata.json") {
    const metadata = await parseJson(filePath);
    if (!isRecord(metadata) || metadata.compat === undefined) continue;

    const location = `${displayPath(filePath)}.compat`;
    if (!isRecord(metadata.compat)) {
      report(location, "expected an object");
      continue;
    }
    unexpectedKeys(metadata.compat, new Set(["data", "feature"]), location);
    if (
      typeof metadata.compat.data !== "string" ||
      normalizeDataPath(metadata.compat.data).length === 0
    ) {
      report(`${location}.data`, "expected a non-empty data path");
      continue;
    }
    if (
      typeof metadata.compat.feature !== "string" ||
      metadata.compat.feature.length === 0
    ) {
      report(`${location}.feature`, "expected a non-empty feature");
      continue;
    }

    documentReferenceCount += 1;
    const dataPath = normalizeDataPath(metadata.compat.data);
    const data = compatibilityFiles.get(dataPath);
    if (!data) {
      report(location, `references missing compatibility data ${dataPath}`);
      continue;
    }
    if (metadata.compat.feature === "*") {
      for (const feature of Object.keys(data)) {
        validateResolvedDocumentUrl(
          resolveCompatibilityEntry(dataPath, feature, location),
          location,
        );
      }
      continue;
    }

    if (Object.hasOwn(data, metadata.compat.feature)) {
      validateResolvedDocumentUrl(
        resolveCompatibilityEntry(dataPath, metadata.compat.feature, location),
        location,
      );
      continue;
    }

    const docPath =
      "/" +
      path.relative(docsRoot, path.dirname(filePath)).split(path.sep).join("/");
    const matchesDocument = Object.keys(data).some(
      (feature) =>
        resolveCompatibilityEntry(dataPath, feature, location)?.url === docPath,
    );
    if (!matchesDocument) {
      report(
        location,
        `references missing feature ${dataPath}#${metadata.compat.feature}`,
      );
    }
    continue;
  }

  if (filename !== "page.svx") continue;
  const source = await readFile(filePath, "utf8");
  for (const match of source.matchAll(/<feature-status\b[^>]*>/g)) {
    const sourceMatch = match[0].match(
      /\bsource\s*=\s*(?:"([^"]*)"|'([^']*)')/,
    );
    const featureMatch = match[0].match(
      /\bfeature\s*=\s*(?:"([^"]*)"|'([^']*)')/,
    );
    const dataPath = sourceMatch?.[1] ?? sourceMatch?.[2];
    const feature = featureMatch?.[1] ?? featureMatch?.[2];
    if (dataPath === undefined && feature === undefined) continue;

    const location = `${displayPath(filePath)} feature-status`;
    if (!dataPath || !feature) {
      report(location, "expected both source and feature attributes");
      continue;
    }
    documentReferenceCount += 1;
    const data = compatibilityFiles.get(normalizeDataPath(dataPath));
    if (!data || !Object.hasOwn(data, feature)) {
      report(location, `references missing feature ${dataPath}#${feature}`);
      continue;
    }
    resolveCompatibilityEntry(dataPath, feature, location);
  }
}

if (errors.length > 0) {
  console.error(errors.map((message) => `- ${message}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${compatibilityFiles.size} compatibility files, ` +
      `${compatibilityEntryCount} entries, and ` +
      `${documentReferenceCount} document references.`,
  );
}
