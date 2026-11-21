#!/bin/sh
# Adapted from the company standard for an app nested under MyApp/.
# Exit codes: 0 = passed/no committed source changes, 42 = valid waiver, 1 = failed.
BASE="$1"
cd "$(git rev-parse --show-toplevel)" || exit 1
LCOV=MyApp/coverage/lcov.info
REPORT=MyApp/coverage/diff-cover.json
MARKER='> 🔴 **ВАЖНО!!! ТЕСТОВ НЕТ!!!**'
# Keep this scope aligned with collectCoverageFrom in MyApp/jest.config.js.
SCOPE='^MyApp/(App\.tsx|index\.ts|src/.*\.(ts|tsx))$'
EXCLUDE='\.test\.|\.styles\.ts$|\.d\.ts$|(^|/)types\.ts$|(^|/)constants\.ts$|^MyApp/src/app/|^MyApp/src/core/testing/'

MERGE_BASE=$(git merge-base "$BASE" HEAD) || exit 1
CHANGED=$(git diff --relative --diff-filter=d --name-only "$MERGE_BASE" HEAD) || exit 1
CODE=$(printf '%s\n' "$CHANGED" | grep -E "$SCOPE" | grep -Ev "$EXCLUDE")
if [ -z "$CODE" ]; then
  echo 'No committed source changes in scope; diff coverage was not measured.'
  exit 0
fi

[ -s "$LCOV" ] || { echo 'Coverage report is missing or empty.' >&2; exit 1; }
# Standard coverage reporters use app-relative paths; diff-cover runs at the Git root.
# Keep the original LCOV unchanged for the standard dashboard.
ROOT_LCOV=MyApp/coverage/lcov.repo.info
node - "$LCOV" "$ROOT_LCOV" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [input, output] = process.argv.slice(2);
const root = process.cwd();
const report = fs.readFileSync(input, 'utf8').replace(/^SF:(.+)$/gm, (_, file) => {
  const absolute = path.isAbsolute(file) || file.startsWith('MyApp/')
    ? path.resolve(root, file)
    : path.resolve(root, 'MyApp', file);
  return `SF:${path.relative(root, absolute).split(path.sep).join('/')}`;
});
fs.writeFileSync(output, report);
NODE
[ "$?" -eq 0 ] || exit 1
LCOV="$ROOT_LCOV"
{ [ "$(grep -c '^SF:' "$LCOV")" -eq "$(grep -c '^end_of_record$' "$LCOV")" ] && grep -q '^DA:' "$LCOV"; } \
  || { echo 'Coverage report is incomplete.' >&2; exit 1; }
MISSING=$(printf '%s\n' "$CODE" | while IFS= read -r file; do grep -Fqx "SF:$file" "$LCOV" || printf '%s\n' "$file"; done)
[ -z "$MISSING" ] || { printf 'Changed files missing from coverage:\n%s\n' "$MISSING" >&2; exit 1; }

rm -f "$REPORT"
./MyApp/node_modules/.bin/diff-cover "$LCOV" --compare-branch="$BASE" --ignore-staged --ignore-unstaged --format "json:$REPORT" \
  || { echo 'diff-cover failed; coverage was not checked.' >&2; exit 1; }
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!Number.isFinite(r.total_percent_covered) || !Number.isInteger(r.total_num_lines)) process.exit(1);
  if (r.total_num_lines === 0) console.log("Changed lines are not executable; no coverage percentage was measured.");
  process.exit(r.total_percent_covered >= 90 ? 0 : 2);
' "$REPORT" 2>/dev/null
STATUS=$?
[ "$STATUS" -eq 0 ] && exit 0
[ "$STATUS" -eq 2 ] || { echo 'Invalid diff-cover report.' >&2; exit 1; }
echo 'Changed-line coverage is below 90%.' >&2

WAIVER=$(git diff --relative --diff-filter=A --name-only "$MERGE_BASE" HEAD -- docs/test-waivers/) || exit 1
[ -n "$WAIVER" ] || exit 1
[ "$(printf '%s\n' "$WAIVER" | grep -c '')" -eq 1 ] || { echo 'More than one coverage waiver.' >&2; exit 1; }
TASK=$(node -e '
  const fs = require("fs"), path = require("path");
  const w = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const ok = /^[0-9]*[A-Z][A-Z0-9]*-[0-9]+$/.test(w.task) && path.basename(process.argv[1]).startsWith(w.task + "-")
    && w.scope === "coverage" && [w.decidedBy, w.reason].every((v) => typeof v === "string" && v.trim());
  if (!ok) process.exit(1);
  console.log(w.task);
' "$WAIVER" 2>/dev/null) || { echo "Invalid waiver: $WAIVER" >&2; exit 1; }
BRANCH=${CI_MERGE_REQUEST_SOURCE_BRANCH_NAME:-$(git branch --show-current)}
printf '%s\n' "$BRANCH" | grep -iqE "(^|[^a-z0-9])$TASK([^0-9]|$)" || { echo "Task key $TASK is missing from branch $BRANCH." >&2; exit 1; }
JOURNAL="docs/task-reports/$TASK.md"
git diff --quiet "$MERGE_BASE" HEAD -- "$JOURNAL" && { echo "Journal $JOURNAL was not changed in this branch." >&2; exit 1; }
grep -Fqx "$MARKER" "$JOURNAL" || { echo "Journal $JOURNAL has no waiver marker." >&2; exit 1; }
echo 'COVERAGE WAIVER:'
cat "$WAIVER"
exit 42
