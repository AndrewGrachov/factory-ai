#!/usr/bin/env bash
# End-to-end for the job board and its driver.
#
#   scripts/test-jobs.sh
#
# Real HTTP, a real database and real containers — but no Claude and no credential. The runners are
# two throwaway images whose entrypoints echo and exit, which is enough to prove the whole path:
# the prompt reaches the container, the exit code and output come back, and the board records them.
#
# Everything it creates it removes: a *_test database, two stub images, one volume, two processes.
#
# Needs: docker (with the compose stack's timescale reachable) and node. No jq, no curl.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

PORT="${PORT:-8129}"
BASE="http://127.0.0.1:$PORT"
DB="${JOBS_TEST_DB:-factory_jobs_test}"
DATABASE_URL="postgres://factory:factory@127.0.0.1:5432/$DB"
IMAGE_OK="factory-jobs-smoke-ok"
IMAGE_FAIL="factory-jobs-smoke-fail"
VOLUME="factory-jobs-smoke-workspaces"

pass=0
fail=0
server_pid=""
driver_pid=""
db_created=""
work="$(mktemp -d)"

ok() {
    printf 'ok   %s\n' "$1"
    pass=$((pass + 1))
}

bad() {
    printf 'FAIL %s\n     %s\n' "$1" "${2:0:400}"
    fail=$((fail + 1))
}

cleanup() {
    [ -n "$driver_pid" ] && kill "$driver_pid" 2>/dev/null
    [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null
    wait 2>/dev/null
    # Only ever drops a database this run created, and only one named *_test.
    if [ -n "$db_created" ]; then
        docker compose exec -T timescale psql -U factory -d postgres \
            -c "drop database if exists $DB" >/dev/null 2>&1
    fi
    docker volume rm "$VOLUME" >/dev/null 2>&1
    docker image rm -f "$IMAGE_OK" "$IMAGE_FAIL" >/dev/null 2>&1
    rm -rf "$work"
}
trap cleanup EXIT

# --- HTTP, in node, so the script needs neither curl nor jq ----------------------------------

api() { # api METHOD PATH [json] -> "<status>\t<body>"
    node -e '
const [base, method, path, body] = process.argv.slice(1);
fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body || undefined,
})
    .then(async (r) => process.stdout.write(r.status + "\t" + (await r.text()).replace(/\s+/g, " ")))
    .catch((e) => process.stdout.write("000\t" + e.message));
' "$BASE" "$1" "$2" "${3:-}"
}

status() { printf '%s' "${1%%$'\t'*}"; }
body() { printf '%s' "${1#*$'\t'}"; }

field() { # field <json> <key>
    node -e 'try { const o = JSON.parse(process.argv[1] || "{}"); process.stdout.write(String(o[process.argv[2]] ?? "")); } catch { process.stdout.write(""); }' \
        "$1" "$2"
}

expect_status() { # expect_status <name> <want> <method> <path> [json]
    local name="$1" want="$2"
    shift 2
    local out got
    out="$(api "$@")"
    got="$(status "$out")"
    if [ "$got" = "$want" ]; then ok "$name"; else bad "$name" "wanted $want, got $got: $(body "$out")"; fi
}

expect_field() { # expect_field <name> <json> <key> <want>
    local got
    got="$(field "$2" "$3")"
    if [ "$got" = "$4" ]; then ok "$1"; else bad "$1" "$3 wanted '$4', got '$got'"; fi
}

expect_contains() { # expect_contains <name> <haystack> <needle>
    case "$2" in
    *"$3"*) ok "$1" ;;
    *) bad "$1" "wanted substring '$3' in: $2" ;;
    esac
}

create_job() { # create_job <command> -> id
    field "$(body "$(api POST /api/jobs "{\"command\":$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1")}")")" id
}

settled() { # settled <id> -> status once it is no longer queued/running, empty otherwise
    local s
    s="$(field "$(body "$(api GET "/api/jobs/$1")")" status)"
    case "$s" in
    queued | running) printf '' ;;
    *) printf '%s' "$s" ;;
    esac
}

await_settled() { # await_settled <id> [seconds] -> final status, or empty on timeout
    local id="$1" limit="${2:-60}" i=0 s=""
    while [ "$i" -lt "$limit" ]; do
        s="$(settled "$id")"
        [ -n "$s" ] && {
            printf '%s' "$s"
            return
        }
        sleep 1
        i=$((i + 1))
    done
    printf ''
}

# --- Bring up everything it needs -------------------------------------------------------------

command -v docker >/dev/null || {
    echo 'test-jobs: docker is required'
    exit 1
}

echo 'starting timescale'
docker compose up -d timescale >/dev/null 2>&1
for _ in $(seq 1 30); do
    docker compose exec -T timescale pg_isready -U factory >/dev/null 2>&1 && break
    sleep 1
done

# The name ends in _test on purpose: it marks the database disposable, and the drop in cleanup()
# refuses anything this run did not create.
if docker compose exec -T timescale psql -U factory -d postgres -tAc \
    "select 1 from pg_database where datname = '$DB'" 2>/dev/null | grep -q 1; then
    echo "reusing database $DB"
else
    docker compose exec -T timescale psql -U factory -d postgres -c "create database $DB" >/dev/null 2>&1 ||
        {
            echo "test-jobs: could not create $DB"
            exit 1
        }
    db_created=1
fi

echo 'building core, server, driver'
npm run build -w core >/dev/null 2>&1 && npm run build -w server >/dev/null 2>&1 &&
    npm run build -w driver >/dev/null 2>&1 || {
    echo 'test-jobs: build failed'
    exit 1
}

echo 'building the stub runner images'
printf 'FROM alpine:3\nENTRYPOINT ["echo"]\n' >"$work/Dockerfile.ok"
printf 'FROM alpine:3\nENTRYPOINT ["sh","-c","echo boom >&2; exit 3"]\n' >"$work/Dockerfile.fail"
docker build -q -t "$IMAGE_OK" -f "$work/Dockerfile.ok" "$work" >/dev/null &&
    docker build -q -t "$IMAGE_FAIL" -f "$work/Dockerfile.fail" "$work" >/dev/null || {
    echo 'test-jobs: could not build the stub images'
    exit 1
}

# An empty config file, so the repo's own factory.toml cannot reach this run: its token would make
# loadConfig refuse a *_test database, and its workspace_root would start cloning repositories.
: >"$work/factory.toml"

echo "starting the board on $BASE"
env -u GITHUB_TOKEN DATABASE_URL="$DATABASE_URL" PORT="$PORT" HOST=127.0.0.1 \
    FACTORY_CONFIG="$work/factory.toml" ORG_WORKSPACE_ROOT= \
    node server/dist/index.js >"$work/server.log" 2>&1 &
server_pid=$!

up=""
for _ in $(seq 1 40); do
    [ "$(status "$(api GET /api/health)")" = '200' ] && {
        up=1
        break
    }
    sleep 1
done
[ -n "$up" ] || {
    echo 'test-jobs: the board never came up'
    tail -20 "$work/server.log"
    exit 1
}

# --- The board on its own --------------------------------------------------------------------

echo
echo '# board'

# The queue is FIFO, so every check below depends on what is already in it. A reused database, or
# a job left by a failed run, would otherwise hand the claim a different job than the one under
# test — which reads as a broken lease rather than a dirty fixture.
docker compose exec -T timescale psql -U factory -d "$DB" -c 'truncate job' >/dev/null 2>&1

expect_status 'health answers'            200 GET /api/health
expect_status 'refuses an empty command'  400 POST /api/jobs '{"command":""}'
expect_status 'refuses a malformed id'    400 GET '/api/jobs/not-a-uuid'
expect_status 'unknown job is 404'        404 GET '/api/jobs/00000000-0000-4000-8000-000000000000'
expect_status 'refuses an unknown status' 400 GET '/api/jobs?status=pending'

id="$(create_job 'board only')"
case "$id" in
*-*-*-*-*) ok 'queues a job' ;;
*) bad 'queues a job' "no id came back: '$id'" ;;
esac
claim="$(body "$(api POST /api/jobs/claim '{"worker":"probe","leaseSeconds":300}')")"
token="$(field "$claim" leaseToken)"
expect_field 'claim returns the command' "$claim" command 'board only'
expect_field 'first attempt is 1'        "$claim" attempts 1

# A live lease is the whole point: nothing else may take this job while probe holds it.
expect_status 'a held job is not offered again' 204 POST /api/jobs/claim '{"worker":"other"}'
expect_status 'heartbeat extends the lease'     200 POST "/api/jobs/$id/heartbeat" "{\"leaseToken\":\"$token\"}"
expect_status 'a wrong token is refused'        409 POST "/api/jobs/$id/complete" \
    '{"leaseToken":"00000000-0000-4000-8000-000000000000","status":"succeeded","exitCode":0,"output":"x"}'
expect_status 'the holder may complete'         200 POST "/api/jobs/$id/complete" \
    "{\"leaseToken\":\"$token\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"hello\"}"

done_body="$(body "$(api GET "/api/jobs/$id")")"
expect_field 'the result is recorded'   "$done_body" status succeeded
expect_field 'the exit code is kept'    "$done_body" exitCode 0
expect_field 'the output is kept'       "$done_body" output hello

# Reclaim, proven by ageing the lease rather than by waiting one out.
reclaim_id="$(create_job 'reclaim me')"
stale="$(field "$(body "$(api POST /api/jobs/claim '{"worker":"dies","leaseSeconds":300}')")" leaseToken)"
docker compose exec -T timescale psql -U factory -d "$DB" \
    -c "update job set lease_expires_at = now() - interval '1 second' where id = '$reclaim_id'" >/dev/null 2>&1
again="$(body "$(api POST /api/jobs/claim '{"worker":"takes-over","leaseSeconds":300}')")"
expect_field 'an expired lease is reclaimed' "$again" id "$reclaim_id"
expect_field 'the attempt count grows'       "$again" attempts 2
# The fencing token, end to end: the first worker is still alive and still wrong.
expect_status 'the superseded worker is refused' 409 POST "/api/jobs/$reclaim_id/complete" \
    "{\"leaseToken\":\"$stale\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"zombie\"}"
api POST "/api/jobs/$reclaim_id/complete" \
    "{\"leaseToken\":\"$(field "$again" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

PARKED_SESSION='55555555-5555-4555-8555-555555555555'
REMOTE_SESSION='cse_015tb2nHhHNrBuL7ZDhn9Wx5'

# Standby, end to end: park a running job, prove it is not handed out while parked, resume it, and
# check the claim carries the session back so the worker restores it rather than starting a new one.
park_id="$(create_job 'park me')"
park_claim="$(body "$(api POST /api/jobs/claim '{"worker":"parks","leaseSeconds":300}')")"
park_token="$(field "$park_claim" leaseToken)"
api POST "/api/jobs/$park_id/session" \
    "{\"leaseToken\":\"$park_token\",\"sessionId\":\"$PARKED_SESSION\"}" >/dev/null
# The second report of an attempt. Not a uuid — it is an opaque token minted by Anthropic's backend
# when the Remote Control bridge connects, and it is what claude.ai/code addresses the session by.
api POST "/api/jobs/$park_id/session" \
    "{\"leaseToken\":\"$park_token\",\"sessionId\":\"$PARKED_SESSION\",\"remoteSessionId\":\"$REMOTE_SESSION\"}" >/dev/null
expect_field 'the remote session is kept' "$(body "$(api GET "/api/jobs/$park_id")")" \
    remoteSessionId "$REMOTE_SESSION"
expect_status 'a running job can be parked'   200 POST "/api/jobs/$park_id/suspend" \
    "{\"leaseToken\":\"$park_token\"}"
parked="$(body "$(api GET "/api/jobs/$park_id")")"
expect_field  'it is on standby'              "$parked" status standby
expect_field  'it keeps its session'          "$parked" sessionId "$PARKED_SESSION"
# The link has to keep working while the job waits to be picked up.
expect_field  'and its remote session'        "$parked" remoteSessionId "$REMOTE_SESSION"
# The reason standby is a status and not just an expired lease: an idle poll must not resume it.
expect_status 'a parked job is not offered'   204 POST /api/jobs/claim '{"worker":"idle-poll"}'
expect_status 'resume needs no lease token'   200 POST "/api/jobs/$park_id/resume" '{}'
resumed="$(body "$(api POST /api/jobs/claim '{"worker":"resumes","leaseSeconds":300}')")"
expect_field  'the resumed job comes back'    "$resumed" id "$park_id"
expect_field  'the claim carries the session' "$resumed" resumeSessionId "$PARKED_SESSION"
# Parking gave back the attempt it took, so this second claim is still attempt 1.
expect_field  'parking did not burn a try'    "$resumed" attempts 1
expect_status 'a running job cannot resume'   409 POST "/api/jobs/$park_id/resume" '{}'
api POST "/api/jobs/$park_id/complete" \
    "{\"leaseToken\":\"$(field "$resumed" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

# --- The driver ------------------------------------------------------------------------------

echo
echo '# driver'

start_driver() { # start_driver <image>
    env JOB_BOARD_URL="$BASE" EXECUTOR_IMAGE="$1" WORKSPACE_VOLUME="$VOLUME" \
        DRIVER_POLL_MS=500 DRIVER_CONCURRENCY=2 DRIVER_LEASE_SECONDS=60 ORG_ID=default \
        node driver/dist/index.js >>"$work/driver.log" 2>&1 &
    driver_pid=$!
}

stop_driver() {
    [ -n "$driver_pid" ] && kill "$driver_pid" 2>/dev/null
    wait "$driver_pid" 2>/dev/null
    driver_pid=""
}

start_driver "$IMAGE_OK"

first="$(create_job 'first prompt')"
second="$(create_job 'second prompt')"
third="$(create_job 'third prompt')"

expect_contains 'runs a queued job'        "$(await_settled "$first")"  succeeded
expect_contains 'runs the second'          "$(await_settled "$second")" succeeded
# Three jobs against a concurrency of two: this one only runs once a slot frees.
expect_contains 'queues past the slots'    "$(await_settled "$third")"  succeeded

ran="$(body "$(api GET "/api/jobs/$first")")"
expect_field    'the exit code comes back' "$ran" exitCode 0
# The stub image echoes its arguments, so the output is the proof the prompt reached the container.
expect_contains 'the prompt reached it'    "$(field "$ran" output)" 'first prompt'
expect_contains 'the driver names itself'  "$(field "$ran" claimedBy)" driver-
expect_field    'one attempt was enough'   "$ran" attempts 1

# The driver mints the session id, passes it to the runner as --session-id and reports it to the
# board. The stub echoes its arguments, so finding the reported id inside the output is what proves
# the two are the same one — a link built from it opens the session the job actually ran as.
session="$(field "$ran" sessionId)"
case "$session" in
    ????????-????-????-????-????????????) ok 'the session id was reported' ;;
    *) bad 'the session id was reported' "got '$session'" ;;
esac
expect_contains 'the runner was given that id' "$(field "$ran" output)" "$session"

stop_driver
start_driver "$IMAGE_FAIL"

failing="$(create_job 'this one fails')"
expect_contains 'a non-zero exit is a failure' "$(await_settled "$failing")" failed
failed_body="$(body "$(api GET "/api/jobs/$failing")")"
expect_field    'the exit code is reported'    "$failed_body" exitCode 3
expect_contains 'stderr is captured'           "$(field "$failed_body" output)" boom

stop_driver

# Nothing may be left running: every runner is --rm, and the driver drains before it exits.
leftover="$(docker ps -aq --filter label=factory.job | wc -l | tr -d ' ')"
if [ "$leftover" = '0' ]; then ok 'no containers left behind'; else bad 'no containers left behind' "$leftover remain"; fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
