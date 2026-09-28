#!/bin/sh
# Review queue for Pokédex Pack Draft rewards. Needs cloud/admin-token.txt (same value as the Worker's ADMIN_TOKEN secret).
#   ./admin.sh pending                 prizes waiting for review, with each player's anti-cheat history
#   ./admin.sh approve <prizeId>       create the Shopify code and show it to the winner in-game
#   ./admin.sh reject <prizeId> "why"  reject a prize
#   ./admin.sh player <customerId>     a player's flags and latest save numbers
#   ./admin.sh clear-flags <customerId> "note"   mark a player's flags as reviewed (lets milestones auto-issue again)
#   ./admin.sh ban <customerId> "why"  remove from leaderboards and reject unissued prizes
#   ./admin.sh prizes                  the 50 most recent prizes
#   ./admin.sh run-monthly [YYYY-MM-DD] queue that month's top 3 now (normally automatic on the 1st)
#   ./admin.sh showcases               published showcases (with customer ids), for picking Showcase of the Month
#   ./admin.sh feature <customerId> [YYYY-MM-DD]  make their showcase this month's pick (queues a 15% prize for approval)
#   ./admin.sh test-code <customerId>  issue a 5% test code to check the Shopify app connection
#   ./admin.sh create-code CODE <packs> [maxUses] [daysValid] [chances]   pack code, once per account (0 = unlimited / never expires); chances = Golden Ticket chances included
#   ./admin.sh whois <customerId>       email/name of the Shopify customer behind an id
#   ./admin.sh codes                    list pack codes and how often each was used
#   ./admin.sh test-credit <customerId>  add $1 store credit to check the store credit permission
#   ./admin.sh check-secrets           describe the stored Shopify credentials (length/format only, never the values)
set -e
cd "$(dirname "$0")"
URL="${PDX_URL:-https://pokedex-saves.gradeworth.workers.dev}"
TOKEN="$(cat admin-token.txt)"
cmd="$1"; shift || true
case "$cmd" in
  approve|reject) body="{\"id\": $1, \"reason\": \"${2:-}\"}" ;;
  player|clear-flags|ban|test-code|test-credit|whois) body="{\"cid\": \"$1\", \"note\": \"${2:-}\", \"reason\": \"${2:-}\"}" ;;
  feature) if [ -n "$2" ]; then body="{\"cid\": \"$1\", \"day\": \"$2\"}"; else body="{\"cid\": \"$1\"}"; fi ;;
  run-monthly) if [ -n "$1" ]; then body="{\"day\": \"$1\"}"; else body="{}"; fi ;;
  create-code) body="{\"code\": \"$1\", \"packs\": ${2:-3}, \"maxUses\": ${3:-0}, \"days\": ${4:-0}, \"chances\": ${5:-0}}" ;;
  pending|prizes|check-secrets|check-scopes|showcases|codes) body="{}" ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
curl -s -X POST "$URL/admin/$cmd" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body"
echo
