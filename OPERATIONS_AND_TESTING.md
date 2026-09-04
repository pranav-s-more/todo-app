# Taskolab Operations and Testing Guide

This guide is the day-to-day runbook for the local Taskolab stack. It is written
for the multi-user milestone: the application service, MySQL database, and
Adminer database UI run together through Docker Compose. It deliberately does
not contain real passwords, JWTs, user accounts, or task data.

## 1. What is running

`docker-compose.yml` defines one local application stack:

```text
Browser
  | http://localhost:5000
  v
app (Node.js + Express)
  | Docker DNS name: mysql:3306
  v
mysql (MySQL 8.4, private Compose network)

Browser
  | http://localhost:8080
  v
adminer (local database administration UI)
  | Docker DNS name: mysql:3306
  v
mysql
```

The `app` and `adminer` ports are bound to `127.0.0.1`, which makes them
reachable from this computer but not directly from other devices on the LAN.
MySQL has no host port at all. The application and Adminer reach it through the
private Docker bridge network using the service name `mysql`.

Persistent database files live in the external Docker volume
`todo_app_mysql_data`. Do not remove that volume unless a data-loss operation is
intentional and a tested backup exists.

## 2. Safe local configuration

Create the local configuration file once. It is ignored by Git.

```powershell
Copy-Item .env.example .env
```

Set real values in `.env`. Set the MySQL root password, a separate base64url
`DB_APP_PASSWORD`, and a unique JWT signing secret. Generate the two generated
values instead of typing predictable strings:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Important rules:

- `.env` is a secret file. Never commit it, paste it into tickets, or put it in
  screenshots.
- If `.env` was ever committed or pushed, treat every value in it as exposed:
  rotate `DB_PASSWORD`, `DB_APP_PASSWORD`, and `JWT_SECRET`. Removing the file
  from the current Git index stops future commits but does not erase old remote
  history. Use `git rm --cached .env`, keep `.env` in `.gitignore`, and clean
  the history only if your organisation's incident process requires it.
- `JWT_SECRET` must be unique per environment and at least 32 characters. A
  new value invalidates existing signed login tokens, which is useful after a
  suspected secret exposure.
- `APP_ORIGIN` is the permitted browser origin for cross-origin API requests.
  Keep it exact: scheme, host, and port must match the browser URL.
- `db-init` is a short-lived private Compose service. It receives the MySQL
  root password only long enough to create/grant `DB_APP_USER`, then exits.
  The running app receives only `DB_APP_USER` and `DB_APP_PASSWORD`.
- Keep `DB_APP_PASSWORD` base64url-compatible as documented in `.env.example`.
  This lets the internal bootstrap script use it safely without printing it.
- The app account has only the database privileges required by the current
  schema migration and runtime. Split migrations into a separate identity
  before a public production deployment.

## 2.1 First multi-user sign-in and legacy task migration

After the upgraded app starts, open `http://localhost:5000` and create your
own Taskolab account. The first account created claims the existing single-user
tasks into an **Imported tasks** workspace. This is deliberate: do not create a
throwaway account first, because that account would become the owner of those
legacy tasks.

Each later user creates their own account first. A workspace owner or admin can
then add that registered user's email from the **Members** dialog and select an
editor or viewer role. This initial version records membership changes in the
activity timeline; it does not yet send email invitations.

Roles are enforced by the API:

- Owner: all workspace actions, including deletion; ownership cannot be
  removed or changed through the UI.
- Admin: manage members except owner protections; create and update tasks.
- Editor: create, update, assign, complete, and delete tasks.
- Viewer: read-only access to task details, members, and activity, but may
  update their own work status on a task to which they are assigned.

## 2.2 Shared task assignments and individual work status

A Taskolab task is one shared piece of work. It can now be assigned to one,
many, or no workspace members. The `task_assignments` table stores one row per
task and person, instead of duplicating a task for each assignee. It is the
sixth current application table, alongside `users`, `workspaces`,
`workspace_members`, `todos`, and `activity_log`.

Each assigned person independently chooses one of these states:

| Personal status | Meaning |
| --- | --- |
| `not_started` | The person has not begun their portion of the work. |
| `in_progress` | The person is actively working on it. |
| `completed` | The person has completed their own portion. |

The task card shows the people assigned and a summary such as `1/2 complete`
or `1 in progress`. The aggregate is informational: it is **completed** only
when every assignee is completed, **in progress** when somebody has started or
the team is in a mixed state, and **not started** when nobody has begun.

This does not automatically toggle the existing task checkbox. That checkbox
remains the project-level decision to close the task, preserving the existing
parent/subtask completion warning. An owner, admin, or editor manages the
assignee list. Any assigned member—including a viewer—can update only their
own personal status. Existing legacy single assignees are copied into
`task_assignments` as `not_started` during startup, without deleting the old
`todos.assignee_user_id` field.

## 3. Start, stop, and inspect

Run these commands from the repository root, the directory that contains
`docker-compose.yml`.

```powershell
# Validate resolved Compose configuration without starting anything.
docker compose config --quiet

# Build the Node.js image when needed and start all services in the background.
docker compose up -d --build

# View service state, ports, and health.
docker compose ps

# Stop services while retaining their containers and data volume.
docker compose stop

# Start previously stopped services without rebuilding.
docker compose start

# Stop and remove containers plus the project network. The external MySQL
# volume remains because `down` does not remove it by default.
docker compose down
```

Useful targeted operations:

```powershell
# Rebuild and recreate only the application after server, frontend, or image changes.
docker compose up -d --build app

# Restart only the Node.js service.
docker compose restart app

# Open a shell inside the running app container.
docker compose exec app sh

# Run a MySQL prompt inside the private database container.
docker compose exec mysql mysql -u root -p
```

`docker compose logs`, `docker compose ps`, and `docker compose config` are
read-only inspection commands. They never restart or create containers. Commands
such as `up`, `start`, `restart`, `stop`, and `down` change container state.

## 4. Logs: where to look first

| Layer | Primary location | What it answers |
| --- | --- | --- |
| Browser | DevTools Console and Network tabs | Was a request sent? What URL, status, response, and CORS error occurred? |
| App file log | `logs/app.log` on the host, `/app/logs/app.log` in the container | API activity and application errors persisted on the host bind mount |
| App container output | `docker compose logs app` | Startup, uncaught errors, health and API activity |
| MySQL container | `docker compose logs mysql` | Database startup, authentication, schema, storage, and crash problems |
| Adminer container | `docker compose logs adminer` | Database UI request and login problems |
| Docker service | Docker Desktop dashboard or Windows Event Viewer | Docker engine, image pulls, volume mounts, and daemon failures |

Use time-bounded logs when diagnosing a fresh problem:

```powershell
docker compose logs --since 15m app
docker compose logs --since 15m mysql
docker compose logs -f app
```

`-f` means follow. It leaves the terminal watching new log entries; press
`Ctrl + C` to stop watching. It does not stop or restart the service.

### A practical diagnosis order

1. Reproduce once and note the exact time, action, user, URL, and error.
2. In the browser Network tab, identify the failing request and HTTP status.
3. Run `docker compose ps`. A service that is `unhealthy`, `restarting`, or
   `exited` is more important than a UI symptom.
4. Read the app logs around the timestamp. Do not start with random restarts.
5. If the app reports a database error, inspect MySQL logs and its health.
6. Run `node scripts/smoke-test.js` to verify the health endpoint without
   changing data.
7. Apply the smallest safe fix, then rerun the exact failed action and record
   the result.

## 5. Smoke testing

The repository includes a no-dependency smoke test at
`scripts/smoke-test.js`. It uses Node 22's built-in `fetch`, does not create
users or tasks, and never prints authorization tokens or passwords.

```powershell
# Check the health endpoint after the stack is running.
node scripts/smoke-test.js

# Target a different local port or deployment URL.
$env:BASE_URL = 'http://localhost:5000'
node scripts/smoke-test.js
Remove-Item Env:BASE_URL
```

When test-only credentials are supplied, the script also verifies the protected
authentication path. Create a dedicated non-production account manually; do not
put a real personal account password in source control.

```powershell
$env:SMOKE_TEST_EMAIL = 'smoke-test@example.invalid'
$env:SMOKE_TEST_PASSWORD = 'replace-with-a-test-only-password'
node scripts/smoke-test.js
Remove-Item Env:SMOKE_TEST_EMAIL, Env:SMOKE_TEST_PASSWORD
```

The optional authenticated checks use the login endpoint, the current-user
endpoint, and the authenticated task-list endpoint. They also verify that each
returned task has a safe shared-assignment response shape. A failure returns a
non-zero process exit code, which is suitable for a future CI pipeline.

## 6. Common incident playbooks

### The browser cannot open Taskolab

```powershell
docker compose ps
docker compose logs --tail 100 app
curl.exe -i http://localhost:5000/health
```

If `app` is not running, read its logs before restarting it. If the error says
the address is already in use, inspect the host process owning port 5000:

```powershell
Get-NetTCPConnection -LocalPort 5000 -ErrorAction SilentlyContinue
Get-Process -Id <owning-process-id>
```

Stop the conflicting application only when you have identified it, or change
the published host port in Compose and use that new port in the browser.

### App health is unavailable or MySQL is unhealthy

```powershell
docker compose ps
docker compose logs --tail 150 mysql
docker compose logs --tail 150 app
docker compose exec mysql mysqladmin ping -h localhost -u root -p
```

Look for incorrect database credentials, failed MySQL initialization, disk
space pressure, or a missing external volume. Do not delete a database volume
as a first response. Confirm its existence first:

```powershell
docker volume inspect todo_app_mysql_data
```

### Login returns 401 or every token suddenly stops working

Check the app logs first. Verify that `JWT_SECRET` exists in the app
environment and was not accidentally changed. A secret rotation deliberately
invalidates all existing tokens, so users must log in again. Also compare the
browser origin with `APP_ORIGIN` if the failure is a CORS error rather than a
401 response.

### Adminer does not open or cannot connect

```powershell
docker compose ps adminer mysql
docker compose logs --tail 100 adminer
docker compose logs --tail 100 mysql
```

Open `http://localhost:8080`. In Adminer, use `mysql` as the server name, not
`localhost`. Inside a container, `localhost` means that same container; Docker
service DNS resolves `mysql` to the database container.

### Changed code is not visible

For server, frontend, Dockerfile, dependency, or configuration changes, rebuild
the app image deliberately:

```powershell
docker compose up -d --build app
docker compose logs --tail 50 app
```

Then hard-refresh the browser with `Ctrl + F5`. Inspect the Network tab to make
sure JavaScript and CSS are not served from an old browser cache.

### A person cannot update their work status or the assignee summary is wrong

First identify whether the failed request is an assignee-list update or a
personal-status update. In the browser Network tab, the two paths are:

```text
PATCH /api/workspaces/<workspaceId>/tasks/<taskId>
PATCH /api/workspaces/<workspaceId>/tasks/<taskId>/assignments/<userId>
```

Then inspect the API result and the application log around the same timestamp:

```powershell
docker compose logs --since 15m --tail 150 app
```

- HTTP `400` normally means an assignee is not a current workspace member or
  the status is not `not_started`, `in_progress`, or `completed`.
- HTTP `403` means the person is trying to update an assignment they do not
  own, or lacks editor-or-higher access to manage the assignee list.
- HTTP `404` means the task or assignment no longer exists, often after a
  member was removed or a task was deleted.

To inspect only status counts without exposing names or task titles, run:

```powershell
docker compose exec mysql mysql -u root -p todo_app -e "SELECT status, COUNT(*) AS assignment_count FROM task_assignments GROUP BY status;"
```

MySQL prompts for the password. Do not put it on the command line or copy it
into a ticket. If a user was removed from a workspace, Taskolab deliberately
removes that user's assignment rows from tasks in that workspace.

## 7. Data protection and recovery

Do not use `docker compose down -v` on this project. The `-v` option can remove
volumes; deleting the external MySQL volume destroys the local database data.

Create a logical backup before schema changes, cleanup experiments, or major
upgrades:

```powershell
New-Item -ItemType Directory -Force backups | Out-Null
docker compose exec -T mysql mysqldump -u root -p --databases todo_app > backups/taskolab-backup.sql
```

The shell redirects backup output on the host. MySQL will prompt for the
password; do not put it directly into a command history. Verify the backup has
content and store it outside the repository. A restore changes data and should
only be performed after you identify the target database and take a new backup.

## 8. Current security controls and next hardening steps

Current local controls:

- The database has no host-published port.
- App and Adminer are loopback-only on the host.
- The app runs as the unprivileged `node` user in its container.
- The app container drops Linux capabilities and blocks privilege escalation.
- Docker container logs are size-limited to prevent unlimited local growth.
- `.env` and `logs/*.log` are ignored by Git; `.env` is also excluded from the
  Docker build context.
- Authentication secrets are sent to the app service, not the MySQL container.
- The application uses bcrypt password hashing, signed JWT sessions, rate
  limiting on authentication endpoints, Helmet response headers, workspace
  role checks, task ownership, multi-assignment validation, personal-status
  authorization, and activity records.
- The running app uses the restricted `DB_APP_USER`, not the MySQL root account.
- The browser stores the current signed token in `localStorage` for this local
  learning implementation. Before an internet-facing deployment, move to
  `HttpOnly`, `Secure`, `SameSite` cookies and add CSRF protection; that reduces
  token theft risk if a script injection vulnerability is introduced.

Required next steps before public deployment:

1. Split schema migrations into a separate least-privilege deployment identity
   so the runtime account no longer needs CREATE/ALTER/INDEX privileges.
2. Replace the exposed Adminer service with a restricted, temporary operations
   path or remove it entirely from public environments.
3. Put the app behind TLS termination and a reverse proxy or managed ingress.
4. Store secrets in a managed secret store rather than a local `.env` file.
5. Add database backups with restore drills, dependency and image scanning,
   centralized logs, metrics, traces, alerts, and incident ownership.
6. Use a managed MySQL service with private networking for cloud deployment.

## 9. Before asking for help: evidence checklist

Collect this information without sharing secrets:

```powershell
docker compose ps
docker compose logs --since 15m --tail 200 app
docker compose logs --since 15m --tail 200 mysql
node scripts/smoke-test.js
```

Also include the exact browser error/status, when it began, what changed just
before it started, and whether the issue affects every user or one user. Redact
passwords, JWTs, cookies, Authorization headers, and personal task content.
