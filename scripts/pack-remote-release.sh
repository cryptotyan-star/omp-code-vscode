#!/usr/bin/env bash
# Assemble one self-contained OMP Code Remote handoff ZIP from already-built artifacts.
# This script never builds, signs, installs, publishes or deploys anything.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)

EXTENSION_VERSION="${OMP_REMOTE_EXTENSION_VERSION:-0.7.0}"
ANDROID_VERSION="${OMP_REMOTE_ANDROID_VERSION:-0.1.0}"
BUNDLE_NAME="OMP-Code-Remote-${EXTENSION_VERSION}-Android-${ANDROID_VERSION}"
OUTPUT_PATH="$ROOT_DIR/release/${BUNDLE_NAME}.zip"
VSIX_PATH=""
DEBUG_APK_PATH=""
RELEASE_APK_PATH=""
RELEASE_AAB_PATH=""
ALLOW_UNVERIFIED=0
FORCE=0

usage() {
  cat <<'EOF'
Usage: scripts/pack-remote-release.sh [options]

Packages artifacts that have already been built. It does not run npm/Gradle,
sign Android artifacts, install applications, publish, or deploy.

Options:
  --vsix PATH          Override omp-code-0.7.0.vsix input path.
  --debug-apk PATH     Override Gradle debug APK input path.
  --release-apk PATH   Override required unsigned release APK input path.
  --release-aab PATH   Override required unsigned release AAB input path.
  --output PATH        Override output ZIP path.
  --allow-unverified   Package with non-PASS required gates; report remains honest.
  --force              Replace exactly the selected output ZIP if it exists.
  --print-layout       Print the canonical archive layout and exit without writes.
  -h, --help           Show this help.
EOF
}

print_layout() {
  cat <<EOF
${BUNDLE_NAME}/
  00-START-HERE.md                                      [required]
  SHA256SUMS                                            [required]
  MANIFEST.tsv                                          [required]
  artifacts/desktop/omp-code-${EXTENSION_VERSION}.vsix [required]
  artifacts/android/omp-code-remote-${ANDROID_VERSION}-debug.apk [required]
  artifacts/android/omp-code-remote-${ANDROID_VERSION}-release-unsigned.apk [required]
  artifacts/android/omp-code-remote-${ANDROID_VERSION}-release.aab [required]
  artifacts/relay/omp-code-remote-relay-<version>-source.tar.gz [required]
  docs/REMOTE_VALIDATION.md                             [required]
  docs/ANDROID_REMOTE_PROTOCOL.md                       [required]
  docs/ANDROID_REMOTE_PLAN.md                           [required]
  docs/ANDROID_REMOTE_PLAN_CRITIQUE.md                  [required]
  docs/ANDROID_SECURITY_SPIKE.md                        [required]
  docs/REMOTE_RELAY_SELF_HOSTING.md                     [required]
  LICENSE                                               [required]
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_file() {
  [ -f "$1" ] || fail "missing required file: $1"
}

first_existing() {
  for candidate in "$@"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "neither shasum nor sha256sum is available"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --vsix|--debug-apk|--release-apk|--release-aab|--output)
      [ "$#" -ge 2 ] || fail "$1 requires a path"
      case "$1" in
        --vsix) VSIX_PATH=$2 ;;
        --debug-apk) DEBUG_APK_PATH=$2 ;;
        --release-apk) RELEASE_APK_PATH=$2 ;;
        --release-aab) RELEASE_AAB_PATH=$2 ;;
        --output) OUTPUT_PATH=$2 ;;
      esac
      shift 2
      ;;
    --allow-unverified)
      ALLOW_UNVERIFIED=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --print-layout)
      print_layout
      exit 0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

cd "$ROOT_DIR"

case "$EXTENSION_VERSION" in
  ''|*[!0-9A-Za-z._-]*) fail "unsafe extension version: $EXTENSION_VERSION" ;;
esac
case "$ANDROID_VERSION" in
  ''|*[!0-9A-Za-z._-]*) fail "unsafe Android version: $ANDROID_VERSION" ;;
esac
case "$OUTPUT_PATH" in
  /*) ;;
  *) OUTPUT_PATH="$ROOT_DIR/$OUTPUT_PATH" ;;
esac

for command_name in node tar zip unzip find sort awk sed wc; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done

ACTUAL_EXTENSION_VERSION=$(node -p "require('./package.json').version")
[ "$ACTUAL_EXTENSION_VERSION" = "$EXTENSION_VERSION" ] || \
  fail "package.json version is $ACTUAL_EXTENSION_VERSION; expected $EXTENSION_VERSION"

ACTUAL_ANDROID_VERSION=$(sed -n 's/^[[:space:]]*versionName[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
  android/app/build.gradle.kts | sed -n '1p')
[ "$ACTUAL_ANDROID_VERSION" = "$ANDROID_VERSION" ] || \
  fail "Android versionName is ${ACTUAL_ANDROID_VERSION:-missing}; expected $ANDROID_VERSION"

RELAY_VERSION=$(node -p "require('./remote-relay/package.json').version")
case "$RELAY_VERSION" in
  ''|*[!0-9A-Za-z._-]*) fail "unsafe relay version: $RELAY_VERSION" ;;
esac

if [ -z "$VSIX_PATH" ]; then
  VSIX_PATH=$(first_existing \
    "$ROOT_DIR/omp-code-${EXTENSION_VERSION}.vsix" \
    "$ROOT_DIR/dist/omp-code-${EXTENSION_VERSION}.vsix" \
    "$ROOT_DIR/release/omp-code-${EXTENSION_VERSION}.vsix") || \
    fail "missing omp-code-${EXTENSION_VERSION}.vsix; run npm run package first"
fi

if [ -z "$DEBUG_APK_PATH" ]; then
  DEBUG_APK_PATH=$(first_existing \
    "$ROOT_DIR/android/app/build/outputs/apk/debug/app-debug.apk" \
    "$ROOT_DIR/android/app/build/outputs/apk/debug/omp-code-remote-${ANDROID_VERSION}-debug.apk") || \
    fail "missing debug APK; run android/gradlew assembleDebug first"
fi

if [ -z "$RELEASE_APK_PATH" ]; then
  RELEASE_APK_PATH=$(first_existing \
    "$ROOT_DIR/android/app/build/outputs/apk/release/app-release-unsigned.apk" \
    "$ROOT_DIR/android/app/build/outputs/apk/release/omp-code-remote-${ANDROID_VERSION}-release-unsigned.apk") || \
    fail "missing unsigned release APK; run android/gradlew assembleRelease first"
fi

if [ -z "$RELEASE_AAB_PATH" ]; then
  RELEASE_AAB_PATH=$(first_existing \
    "$ROOT_DIR/android/app/build/outputs/bundle/release/app-release.aab" \
    "$ROOT_DIR/android/app/build/outputs/bundle/release/omp-code-remote-${ANDROID_VERSION}-release.aab") || \
    fail "missing unsigned release AAB; run android/gradlew bundleRelease first"
fi

require_file "$VSIX_PATH"
require_file "$DEBUG_APK_PATH"
require_file "$RELEASE_APK_PATH"
require_file "$RELEASE_AAB_PATH"
require_file "$ROOT_DIR/ANDROID_REMOTE_START_HERE.md"
require_file "$ROOT_DIR/REMOTE_VALIDATION.md"
require_file "$ROOT_DIR/ANDROID_REMOTE_PROTOCOL.md"
require_file "$ROOT_DIR/ANDROID_REMOTE_PLAN.md"
require_file "$ROOT_DIR/ANDROID_REMOTE_PLAN_CRITIQUE.md"
require_file "$ROOT_DIR/android/docs/SECURITY_SPIKE.md"
require_file "$ROOT_DIR/remote-relay/README.md"
require_file "$ROOT_DIR/LICENSE"

VSIX_INTERNAL_VERSION=$(unzip -p "$VSIX_PATH" extension/package.json 2>/dev/null | \
  node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { try { process.stdout.write(String(JSON.parse(s).version || "")); } catch { process.exit(2); } });') || \
  fail "cannot read extension/package.json from VSIX: $VSIX_PATH"
[ "$VSIX_INTERNAL_VERSION" = "$EXTENSION_VERSION" ] || \
  fail "VSIX internal version is ${VSIX_INTERNAL_VERSION:-missing}; expected $EXTENSION_VERSION"

if unzip -Z1 "$VSIX_PATH" | awk '
  BEGIN { bad=0 }
  {
    entry=tolower($0)
  }
  entry ~ /(^|\/)(node_modules|\.gradle|build|projects|android|remote-relay)(\/|$)/ ||
  entry ~ /(^|\/)(local\.properties|\.env([^\/]*)?|\.npmrc|[^\/]*secret[^\/]*|[^\/]*\.pem|[^\/]*\.key|[^\/]*\.p12|[^\/]*\.pfx|[^\/]*\.jks|[^\/]*\.keystore)$/ {
    print "unsafe VSIX entry: " $0 > "/dev/stderr"; bad=1
  }
  END { exit bad }
'; then
  :
else
  fail "VSIX contains a forbidden path"
fi

INVALID_STATUS=$(awk -F'|' '
  /^<!-- GATES:BEGIN -->/ { inside=1; next }
  /^<!-- GATES:END -->/ { inside=0 }
  inside && $2 ~ /^[[:space:]]*[A-Z0-9]+-[0-9]+[[:space:]]*$/ {
    status=$5
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", status)
    if (status !~ /^(PASS|FAIL|BLOCKED|NOT_RUN|NOT_APPLICABLE)$/) print status
  }
' "$ROOT_DIR/REMOTE_VALIDATION.md")
[ -z "$INVALID_STATUS" ] || fail "validation report contains invalid status: $INVALID_STATUS"

INVALID_REQUIRED=$(awk -F'|' '
  /^<!-- GATES:BEGIN -->/ { inside=1; next }
  /^<!-- GATES:END -->/ { inside=0 }
  inside && $2 ~ /^[[:space:]]*[A-Z0-9]+-[0-9]+[[:space:]]*$/ {
    required=$4
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", required)
    if (required !~ /^(YES|NO)$/) print required
  }
' "$ROOT_DIR/REMOTE_VALIDATION.md")
[ -z "$INVALID_REQUIRED" ] || fail "validation report contains invalid Required value: $INVALID_REQUIRED"

GATE_COUNT=$(awk -F'|' '
  /^<!-- GATES:BEGIN -->/ { inside=1; next }
  /^<!-- GATES:END -->/ { inside=0 }
  inside && $2 ~ /^[[:space:]]*[A-Z0-9]+-[0-9]+[[:space:]]*$/ { count++ }
  END { print count+0 }
' "$ROOT_DIR/REMOTE_VALIDATION.md")
[ "$GATE_COUNT" -gt 0 ] || fail "validation report contains no machine-readable gates"

REPORT_SCHEMA=$(sed -n 's/^schema:[[:space:]]*//p' "$ROOT_DIR/REMOTE_VALIDATION.md" | sed -n '1p')
[ "$REPORT_SCHEMA" = "omp-code-remote-validation/v1" ] || \
  fail "unexpected validation schema: ${REPORT_SCHEMA:-missing}"
REPORT_EXTENSION_VERSION=$(sed -n 's/^extension_version:[[:space:]]*//p' "$ROOT_DIR/REMOTE_VALIDATION.md" | sed -n '1p')
REPORT_ANDROID_VERSION=$(sed -n 's/^android_version:[[:space:]]*//p' "$ROOT_DIR/REMOTE_VALIDATION.md" | sed -n '1p')
[ "$REPORT_EXTENSION_VERSION" = "$EXTENSION_VERSION" ] || \
  fail "validation extension version is ${REPORT_EXTENSION_VERSION:-missing}; expected $EXTENSION_VERSION"
[ "$REPORT_ANDROID_VERSION" = "$ANDROID_VERSION" ] || \
  fail "validation Android version is ${REPORT_ANDROID_VERSION:-missing}; expected $ANDROID_VERSION"

OVERALL_STATUS=$(sed -n 's/^overall_status:[[:space:]]*//p' "$ROOT_DIR/REMOTE_VALIDATION.md" | sed -n '1p')
case "$OVERALL_STATUS" in
  PASS|FAIL|BLOCKED|NOT_RUN|NOT_APPLICABLE) ;;
  *) fail "invalid overall_status: ${OVERALL_STATUS:-missing}" ;;
esac
REQUIRED_BLOCKERS=$(awk -F'|' '
  /^<!-- GATES:BEGIN -->/ { inside=1; next }
  /^<!-- GATES:END -->/ { inside=0 }
  inside && $2 ~ /^[[:space:]]*[A-Z0-9]+-[0-9]+[[:space:]]*$/ {
    gate=$2; required=$4; status=$5
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", gate)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", required)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", status)
    if (required == "YES" && status != "PASS") print gate "=" status
  }
' "$ROOT_DIR/REMOTE_VALIDATION.md")

if [ "$OVERALL_STATUS" != "PASS" ] || [ -n "$REQUIRED_BLOCKERS" ]; then
  if [ "$ALLOW_UNVERIFIED" -ne 1 ]; then
    printf 'validation overall_status=%s\n' "${OVERALL_STATUS:-missing}" >&2
    if [ -n "$REQUIRED_BLOCKERS" ]; then
      printf 'required non-PASS gates:\n%s\n' "$REQUIRED_BLOCKERS" >&2
    fi
    fail "validation is incomplete; update evidence or use --allow-unverified for an explicitly non-release handoff"
  fi
  printf 'warning: packaging an unverified handoff (overall_status=%s)\n' "${OVERALL_STATUS:-missing}" >&2
fi

case "$OUTPUT_PATH" in
  *.zip) ;;
  *) fail "output path must end in .zip: $OUTPUT_PATH" ;;
esac

OUTPUT_DIR=$(dirname -- "$OUTPUT_PATH")
mkdir -p "$OUTPUT_DIR"
OUTPUT_CANONICAL=$(CDPATH= cd -- "$OUTPUT_DIR" && pwd -P)/$(basename -- "$OUTPUT_PATH")
for input_path in "$VSIX_PATH" "$DEBUG_APK_PATH" "$RELEASE_APK_PATH" "$RELEASE_AAB_PATH"; do
  INPUT_CANONICAL=$(CDPATH= cd -- "$(dirname -- "$input_path")" && pwd -P)/$(basename -- "$input_path")
  [ "$OUTPUT_CANONICAL" != "$INPUT_CANONICAL" ] || fail "output path collides with input artifact: $input_path"
done

if [ -e "$OUTPUT_PATH" ] && [ "$FORCE" -ne 1 ]; then
  fail "output already exists: $OUTPUT_PATH (use --force to replace exactly this file)"
fi

STAGING_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/omp-code-remote-release.XXXXXX")
cleanup() {
  case "$STAGING_ROOT" in
    "${TMPDIR:-/tmp}"/omp-code-remote-release.*) rm -rf -- "$STAGING_ROOT" ;;
    *) printf 'warning: refusing to clean unexpected temporary path: %s\n' "$STAGING_ROOT" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

BUNDLE_DIR="$STAGING_ROOT/$BUNDLE_NAME"
mkdir -p \
  "$BUNDLE_DIR/artifacts/desktop" \
  "$BUNDLE_DIR/artifacts/android" \
  "$BUNDLE_DIR/artifacts/relay" \
  "$BUNDLE_DIR/docs"

cp "$ROOT_DIR/ANDROID_REMOTE_START_HERE.md" "$BUNDLE_DIR/00-START-HERE.md"
cp "$VSIX_PATH" "$BUNDLE_DIR/artifacts/desktop/omp-code-${EXTENSION_VERSION}.vsix"
cp "$DEBUG_APK_PATH" "$BUNDLE_DIR/artifacts/android/omp-code-remote-${ANDROID_VERSION}-debug.apk"

cp "$RELEASE_APK_PATH" \
  "$BUNDLE_DIR/artifacts/android/omp-code-remote-${ANDROID_VERSION}-release-unsigned.apk"
cp "$RELEASE_AAB_PATH" \
  "$BUNDLE_DIR/artifacts/android/omp-code-remote-${ANDROID_VERSION}-release.aab"

cp "$ROOT_DIR/REMOTE_VALIDATION.md" "$BUNDLE_DIR/docs/REMOTE_VALIDATION.md"
cp "$ROOT_DIR/ANDROID_REMOTE_PROTOCOL.md" "$BUNDLE_DIR/docs/ANDROID_REMOTE_PROTOCOL.md"
cp "$ROOT_DIR/ANDROID_REMOTE_PLAN.md" "$BUNDLE_DIR/docs/ANDROID_REMOTE_PLAN.md"
cp "$ROOT_DIR/ANDROID_REMOTE_PLAN_CRITIQUE.md" "$BUNDLE_DIR/docs/ANDROID_REMOTE_PLAN_CRITIQUE.md"
cp "$ROOT_DIR/android/docs/SECURITY_SPIKE.md" "$BUNDLE_DIR/docs/ANDROID_SECURITY_SPIKE.md"
cp "$ROOT_DIR/remote-relay/README.md" "$BUNDLE_DIR/docs/REMOTE_RELAY_SELF_HOSTING.md"
cp "$ROOT_DIR/LICENSE" "$BUNDLE_DIR/LICENSE"

RELAY_FILES=(
  remote-relay/Dockerfile
  remote-relay/README.md
  remote-relay/package.json
  remote-relay/package-lock.json
)
while IFS= read -r relay_source; do
  RELAY_FILES+=("$relay_source")
done < <(find remote-relay -type f \( -name '*.mjs' -o -name '*.cjs' -o -name '*.js' \) \
  ! -path '*/node_modules/*' ! -path '*/build/*' ! -path '*/dist/*' ! -path '*/coverage/*')

for relay_file in "${RELAY_FILES[@]}"; do
  require_file "$ROOT_DIR/$relay_file"
done

RELAY_ARCHIVE="$BUNDLE_DIR/artifacts/relay/omp-code-remote-relay-${RELAY_VERSION}-source.tar.gz"
tar -czf "$RELAY_ARCHIVE" -C "$ROOT_DIR" "${RELAY_FILES[@]}"

if tar -tzf "$RELAY_ARCHIVE" | awk '
  BEGIN { bad=0 }
  {
    entry=tolower($0)
  }
  entry ~ /(^|\/)(node_modules|\.gradle|build|dist|coverage)(\/|$)/ ||
  entry ~ /(^|\/)(local\.properties|\.env([^\/]*)?|\.npmrc|[^\/]*secret[^\/]*|[^\/]*\.pem|[^\/]*\.key|[^\/]*\.p12|[^\/]*\.pfx|[^\/]*\.jks|[^\/]*\.keystore)$/ {
    print "unsafe relay archive entry: " $0 > "/dev/stderr"; bad=1
  }
  END { exit bad }
'; then
  :
else
  fail "relay source archive contains a forbidden path"
fi

{
  printf 'path\tkind\trequired\tversion\tsigning\n'
  printf 'artifacts/desktop/omp-code-%s.vsix\tdesktop-vsix\tYES\t%s\tpublisher-unverified\n' \
    "$EXTENSION_VERSION" "$EXTENSION_VERSION"
  printf 'artifacts/android/omp-code-remote-%s-debug.apk\tandroid-debug-apk\tYES\t%s-debug\tdebug-key\n' \
    "$ANDROID_VERSION" "$ANDROID_VERSION"
  printf 'artifacts/android/omp-code-remote-%s-release-unsigned.apk\tandroid-release-apk\tYES\t%s\tunsigned\n' \
    "$ANDROID_VERSION" "$ANDROID_VERSION"
  printf 'artifacts/android/omp-code-remote-%s-release.aab\tandroid-release-aab\tYES\t%s\tunsigned\n' \
    "$ANDROID_VERSION" "$ANDROID_VERSION"
  printf 'artifacts/relay/omp-code-remote-relay-%s-source.tar.gz\trelay-source\tYES\t%s\tnot-applicable\n' \
    "$RELAY_VERSION" "$RELAY_VERSION"
} > "$BUNDLE_DIR/MANIFEST.tsv"

(
  cd "$BUNDLE_DIR"
  find . -type f ! -name SHA256SUMS -print | sed 's#^\./##' | LC_ALL=C sort | \
    while IFS= read -r relative_path; do
      digest=$(sha256_file "$BUNDLE_DIR/$relative_path")
      printf '%s  %s\n' "$digest" "$relative_path"
    done > SHA256SUMS
)

if [ "$FORCE" -eq 1 ] && [ -e "$OUTPUT_PATH" ]; then
  rm -f -- "$OUTPUT_PATH"
fi

(
  cd "$STAGING_ROOT"
  zip -X -q -r "$OUTPUT_PATH" "$BUNDLE_NAME"
)

if unzip -Z1 "$OUTPUT_PATH" | awk '
  BEGIN { bad=0 }
  {
    entry=tolower($0)
  }
  entry ~ /(^|\/)(node_modules|\.gradle|build)(\/|$)/ ||
  entry ~ /(^|\/)(local\.properties|\.env([^\/]*)?|\.npmrc|[^\/]*secret[^\/]*|[^\/]*\.pem|[^\/]*\.key|[^\/]*\.p12|[^\/]*\.pfx|[^\/]*\.jks|[^\/]*\.keystore)$/ {
    print "unsafe ZIP entry: " $0 > "/dev/stderr"; bad=1
  }
  END { exit bad }
'; then
  :
else
  fail "release ZIP contains a forbidden path"
fi

ARCHIVE_SHA256=$(sha256_file "$OUTPUT_PATH")
ARCHIVE_BYTES=$(wc -c < "$OUTPUT_PATH" | awk '{print $1}')
printf 'built: %s\n' "$OUTPUT_PATH"
printf 'sha256: %s\n' "$ARCHIVE_SHA256"
printf 'bytes: %s\n' "$ARCHIVE_BYTES"
printf 'root: %s/\n' "$BUNDLE_NAME"
