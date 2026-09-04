#!/bin/sh
set -eu

fail() {
  echo "Taskolab database bootstrap failed: $1" >&2
  exit 1
}

# These names are used as SQL identifiers, so restrict them rather than trying
# to escape arbitrary identifier input in shell-generated SQL.
case "${MYSQL_DATABASE:-}" in
  ''|*[!A-Za-z0-9_]*) fail 'MYSQL_DATABASE must use only letters, numbers, and underscores' ;;
esac
case "${MYSQL_APP_USER:-}" in
  ''|*[!A-Za-z0-9_]*) fail 'MYSQL_APP_USER must use only letters, numbers, and underscores' ;;
esac

# The documented generator creates base64url output. Restricting this secret
# makes its safe use in the one-time SQL statement explicit and avoids shell or
# SQL quoting surprises. Root credentials are never printed.
case "${MYSQL_APP_PASSWORD:-}" in
  ''|*[!A-Za-z0-9_-]*) fail 'MYSQL_APP_PASSWORD must be a non-empty base64url value' ;;
esac

# The root secret is already supplied to this short-lived container as an
# environment variable. MYSQL_PWD keeps it out of the process command line,
# avoiding the MySQL client warning and accidental command-line exposure.
MYSQL_PWD="${MYSQL_ROOT_PASSWORD}" mysql -h "${MYSQL_HOST:-mysql}" -P "${MYSQL_PORT:-3306}" -u root <<SQL
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${MYSQL_APP_USER}'@'%' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
ALTER USER '${MYSQL_APP_USER}'@'%' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_APP_USER}'@'%';
FLUSH PRIVILEGES;
SQL

echo 'Taskolab restricted database account is ready.'
