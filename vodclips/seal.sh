#!/bin/sh
# Encrypts the secrets the box needs to the Hermes agent's SSH key, so they
# can travel in the repository (vodclips/README.md, "Setup by the Hermes agent").
#
#   sh vodclips/seal.sh [path to .env]     (default ~/Projects/jeviatus/.env)
#
# Only TYPESAFE_API_KEY goes in: Hermes adds its own LLM provider for the
# hooks. Writes vodclips/secrets.env.age; nothing is printed.
set -eu
cd "$(dirname "$0")/.."
src=${1:-$HOME/Projects/jeviatus/.env}
command -v age >/dev/null || brew install age
line=$(grep '^TYPESAFE_API_KEY=' "$src") || { echo "no TYPESAFE_API_KEY in $src" >&2; exit 1; }
printf '%s\n' "$line" | age -R vodclips/hermes.pub -o vodclips/secrets.env.age
echo "sealed TYPESAFE_API_KEY to $(ssh-keygen -lf vodclips/hermes.pub | cut -d' ' -f2) in vodclips/secrets.env.age"
