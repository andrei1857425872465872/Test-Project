// Builds one self-contained HTML page with two sections: test results (from
// allure-results/) and code coverage (from coverage/lcov.info). It runs after
// `npm run test:report`, needs no server and works offline.
// Usage: node scripts/test-dashboard.mjs [--run] [--serve] [--open]
//   --run    first runs `npm run test:report` (tests with coverage and the Allure
//            report), so the page never shows stale data. The page is built even
//            when tests fail; the command then exits with the test status.
//   --serve  serves the dashboard, the Allure report and the HTML coverage report on
//            127.0.0.1, so their links work (Allure can't load its data from disk).
//   --open   opens the dashboard in the browser.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const RESULTS_DIR = "allure-results";
const LCOV_FILE = "coverage/lcov.info";
// Statements are not in lcov: they come from the json-summary reporter of the same run.
const SUMMARY_FILE = "coverage/coverage-summary.json";
const OUTPUT_DIR = "test-dashboard";
const OUTPUT_FILE = join(OUTPUT_DIR, "index.html");
// Full reports the dashboard links to, relative to the project root.
const ALLURE_REPORT = "allure-report/index.html";
const COVERAGE_REPORT = "coverage/lcov-report/index.html";
// Only these folders are served; the rest of the project stays private.
const SERVED_FOLDERS = [OUTPUT_DIR, "allure-report", "coverage/lcov-report"];
const SERVER_HOST = "127.0.0.1";
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
// Coverage colors: the changed-lines threshold of the testing standard, and a lower alarm level.
const COVERAGE_WARN_BELOW = 90;
const COVERAGE_BAD_BELOW = 80;
// Keeps the page small: an error message and a stack rarely need more.
const MAX_MESSAGE_LENGTH = 2000;
const MAX_TRACE_LENGTH = 6000;
// Earlier runs of each test shown as a strip; the same history file Allure writes.
const HISTORY_FILE =
  process.env.ALLURE_HISTORY_PATH ?? "allure-history/local.jsonl";
const HISTORY_LIMIT = 10;

// Terminal colors in Jest messages: ESC [ ... m. Built from the code so the regex has no control character.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const TEST_FILE_PATTERN = /\.test\.[^/]+$/;

const cleanText = (text, maxLength) => {
  if (!text) return "";
  const plain = text
    .replace(ANSI_PATTERN, "")
    .replaceAll(process.cwd() + "/", "");
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}\n…` : plain;
};

// src/modules/auth/... → auth; src/core/api/... → core/api; src/app/... → app.
const getModule = (path) => {
  const parts = path.split("/");
  if (parts[0] !== "src") return parts[0];
  if (parts[1] === "modules" || parts[1] === "core") {
    return parts[1] === "core" ? `core/${parts[2]}` : parts[2];
  }
  return parts[1];
};

const firstLabel = (labels, name) =>
  labels.find((label) => label.name === name)?.value;

// Set up and tear down hooks (beforeAll, beforeEach, afterEach, afterAll) per test result.
function readHooks() {
  const hooks = new Map();
  for (const fileName of readdirSync(RESULTS_DIR)) {
    if (!fileName.endsWith("-container.json")) continue;
    let container;
    try {
      container = JSON.parse(readFileSync(join(RESULTS_DIR, fileName), "utf8"));
    } catch {
      continue;
    }
    const toHook = (fixture, phase) => ({
      phase,
      name: fixture.name,
      status: fixture.status,
      start: fixture.start ?? 0,
      duration: Math.max(0, (fixture.stop ?? 0) - (fixture.start ?? 0)),
      message: cleanText(fixture.statusDetails?.message, MAX_MESSAGE_LENGTH),
    });
    const fixtures = [
      ...(container.befores ?? []).map((fixture) => toHook(fixture, "setup")),
      ...(container.afters ?? []).map((fixture) => toHook(fixture, "teardown")),
    ];
    for (const child of container.children ?? []) {
      hooks.set(child, [...(hooks.get(child) ?? []), ...fixtures]);
    }
  }
  return hooks;
}

// The adapter can record the same hook twice for a failed test; keep one, set up first, in run order.
function uniqueHooks(hooks) {
  const seen = new Set();
  return hooks
    .filter((hook) => {
      const key = `${hook.phase}|${hook.name}|${hook.start}|${hook.duration}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        (a.phase === b.phase ? 0 : a.phase === "setup" ? -1 : 1) ||
        a.start - b.start,
    );
}

// Allure keys history by its own test ID, which differs from the one in results.
// The full name plus the parameters hash (the platform) match in both places.
const historyLookupKey = (fullName, parametersHash) =>
  `${fullName}|${parametersHash}`;

// Statuses of each test in the latest saved runs, oldest first.
function readHistory() {
  const history = new Map();
  if (!existsSync(HISTORY_FILE)) return history;
  const entries = readFileSync(HISTORY_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-HISTORY_LIMIT);
  for (const line of entries) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const [historyKey, result] of Object.entries(
      entry.testResults ?? {},
    )) {
      const key = historyLookupKey(result.fullName, historyKey.split(".")[1]);
      history.set(key, [
        ...(history.get(key) ?? []),
        { status: result.status, at: entry.timestamp },
      ]);
    }
  }
  return history;
}

function readTests() {
  if (!existsSync(RESULTS_DIR)) return { tests: [], runAt: null };
  // Allure keeps results of every run in the folder: keep the latest execution of each test.
  const latest = new Map();
  const hooks = readHooks();
  const history = readHistory();
  for (const fileName of readdirSync(RESULTS_DIR)) {
    if (!fileName.endsWith("-result.json")) continue;
    let result;
    try {
      result = JSON.parse(readFileSync(join(RESULTS_DIR, fileName), "utf8"));
    } catch {
      continue;
    }
    const platform =
      result.parameters?.find((parameter) => parameter.name === "platform")
        ?.value ?? "unknown";
    const key = `${result.fullName}|${platform}`;
    if ((latest.get(key)?.stop ?? 0) < (result.stop ?? 0))
      latest.set(key, { ...result, platform });
  }

  const tests = new Map();
  let runAt = 0;
  for (const result of latest.values()) {
    const titlePath = result.titlePath ?? [];
    const fileIndex = titlePath.findIndex((part) =>
      TEST_FILE_PATTERN.test(part),
    );
    if (fileIndex < 0) continue;
    const file = titlePath.slice(1, fileIndex + 1).join("/");
    // A result of a test file that was deleted or renamed since.
    if (!existsSync(file)) continue;
    runAt = Math.max(runAt, result.stop ?? 0);
    const suite = titlePath.slice(fileIndex + 1).join(" › ");
    const id = `${file}#${suite}#${result.name}`;
    const test = tests.get(id) ?? {
      id,
      name: result.name,
      suite,
      file,
      module: getModule(file),
      kind: firstLabel(result.labels ?? [], "layer") ?? "other",
      runs: [],
    };
    test.runs.push({
      platform: result.platform,
      status: result.status,
      duration: Math.max(0, (result.stop ?? 0) - (result.start ?? 0)),
      message: cleanText(result.statusDetails?.message, MAX_MESSAGE_LENGTH),
      trace: cleanText(result.statusDetails?.trace, MAX_TRACE_LENGTH),
      start: result.start ?? null,
      hooks: uniqueHooks(hooks.get(result.uuid) ?? []),
      history:
        history.get(
          historyLookupKey(result.fullName, result.historyId?.split(":")[1]),
        ) ?? [],
    });
    tests.set(id, test);
  }
  return { tests: [...tests.values()], runAt: runAt || null };
}

function readStatements() {
  if (!existsSync(SUMMARY_FILE)) return new Map();
  const summary = JSON.parse(readFileSync(SUMMARY_FILE, "utf8"));
  const root = `${process.cwd()}/`;
  return new Map(
    Object.entries(summary)
      .filter(([path]) => path !== "total")
      .map(([path, metrics]) => [path.replace(root, ""), metrics.statements]),
  );
}

function readCoverage() {
  if (!existsSync(LCOV_FILE)) return [];
  const statements = readStatements();
  const files = [];
  let current = null;
  for (const line of readFileSync(LCOV_FILE, "utf8").split("\n")) {
    const [tag, value = ""] = line.split(/:(.*)/s);
    if (tag === "SF") {
      current = {
        path: value,
        lines: {},
        branches: {},
        linesFound: 0,
        linesHit: 0,
        branchesFound: 0,
        branchesHit: 0,
        functionsFound: 0,
        functionsHit: 0,
      };
    } else if (!current) {
      continue;
    } else if (tag === "DA") {
      const [lineNumber, hits] = value.split(",").map(Number);
      current.lines[lineNumber] = hits;
    } else if (tag === "BRDA") {
      // A line has a partly covered branch when one of its branches was never taken.
      const [lineNumber, , , taken] = value.split(",");
      const branch = (current.branches[lineNumber] ??= { found: 0, hit: 0 });
      branch.found += 1;
      if (taken !== "-" && Number(taken) > 0) branch.hit += 1;
    } else if (tag === "LF") current.linesFound = Number(value);
    else if (tag === "LH") current.linesHit = Number(value);
    else if (tag === "BRF") current.branchesFound = Number(value);
    else if (tag === "BRH") current.branchesHit = Number(value);
    else if (tag === "FNF") current.functionsFound = Number(value);
    else if (tag === "FNH") current.functionsHit = Number(value);
    else if (tag === "end_of_record") {
      const partialLines = Object.entries(current.branches)
        .filter(([, branch]) => branch.hit < branch.found)
        .map(([lineNumber]) => Number(lineNumber));
      files.push({
        path: current.path,
        module: getModule(current.path),
        lines: current.lines,
        partialLines,
        linesFound: current.linesFound,
        linesHit: current.linesHit,
        branchesFound: current.branchesFound,
        branchesHit: current.branchesHit,
        functionsFound: current.functionsFound,
        functionsHit: current.functionsHit,
        statementsFound: statements.get(current.path)?.total ?? null,
        statementsHit: statements.get(current.path)?.covered ?? null,
        source: existsSync(current.path)
          ? readFileSync(current.path, "utf8")
          : "",
      });
      current = null;
    }
  }
  return files;
}

// The app name for the page title "<name> Tests": the Expo app name, else package.json.
function readProjectName() {
  for (const config of ["app.config.ts", "app.config.js"]) {
    if (!existsSync(config)) continue;
    const match = readFileSync(config, "utf8").match(
      /^\s*name:\s*["'`]([^"'`]+)["'`]/m,
    );
    if (match) return match[1];
  }
  if (existsSync("app.json")) {
    try {
      const name = JSON.parse(readFileSync("app.json", "utf8")).expo?.name;
      if (name) return name;
    } catch {
      // Fall back to package.json below.
    }
  }
  try {
    return JSON.parse(readFileSync("package.json", "utf8")).name ?? "Project";
  } catch {
    return "Project";
  }
}

// JSON inside <script> must not be able to close the tag.
const embedJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

// Exit code of the test run when --run is used; the page is still built on failures.
let testStatus = 0;
if (process.argv.includes("--run")) {
  const run = spawnSync("npm", ["run", "test:report"], { stdio: "inherit" });
  testStatus = run.status ?? 1;
}

const { tests, runAt } = readTests();
const coverage = readCoverage();
if (tests.length === 0 && coverage.length === 0) {
  console.error(
    `Nothing to show: no ${RESULTS_DIR}/ or ${LCOV_FILE}. Run "npm run test:report" first.`,
  );
  process.exit(1);
}

const data = {
  projectName: readProjectName(),
  generatedAt: Date.now(),
  runAt,
  coverageAt: existsSync(LCOV_FILE) ? statSync(LCOV_FILE).mtimeMs : null,
  thresholds: { warn: COVERAGE_WARN_BELOW, bad: COVERAGE_BAD_BELOW },
  // Paths from the dashboard folder; null hides the button when the report wasn't built.
  reports: {
    allure: existsSync(ALLURE_REPORT) ? `../${ALLURE_REPORT}` : null,
    coverage: existsSync(COVERAGE_REPORT) ? `../${COVERAGE_REPORT}` : null,
  },
  tests,
  coverage,
};

const template = readFileSync(
  new URL("./test-dashboard.html", import.meta.url),
  "utf8",
);
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(
  OUTPUT_FILE,
  template.replace(/\/\*__DATA__\*\/\s*null/, () => embedJson(data)),
);

const executions = tests.reduce((total, test) => total + test.runs.length, 0);
console.log(
  `Test dashboard: ${executions} test runs, ${coverage.length} files with coverage → ${OUTPUT_FILE}`,
);

const openInBrowser = (target) => {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [target], { stdio: "ignore", detached: true }).unref();
};

function serve() {
  const root = process.cwd();
  const server = createServer((request, response) => {
    const path = normalize(
      decodeURIComponent(new URL(request.url, "http://localhost").pathname),
    ).replace(/^\/+/, "");
    const file =
      path.endsWith("/") || path === "" ? join(path, "index.html") : path;
    const allowed = SERVED_FOLDERS.some((folder) =>
      file.startsWith(`${folder}/`),
    );
    const absolute = resolve(root, file);
    if (!allowed || !absolute.startsWith(root) || !existsSync(absolute)) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type":
        CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    });
    response.end(readFileSync(absolute));
  });
  // Port 0: the system picks a free one.
  server.listen(0, SERVER_HOST, () => {
    const url = `http://${SERVER_HOST}:${server.address().port}/${OUTPUT_DIR}/`;
    console.log(`Serving on ${url} (Ctrl+C to stop)`);
    if (testStatus)
      console.log(
        `Tests failed: exit code ${testStatus} after the server stops.`,
      );
    if (process.argv.includes("--open")) openInBrowser(url);
  });
}

// Ctrl+C stops the server; the command still reports whether the tests passed.
process.on("SIGINT", () => process.exit(testStatus));

if (process.argv.includes("--serve")) serve();
else {
  if (process.argv.includes("--open")) openInBrowser(resolve(OUTPUT_FILE));
  process.exitCode = testStatus;
}
