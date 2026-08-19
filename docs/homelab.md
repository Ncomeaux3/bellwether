# Running Bellwether on the homelab

Written for someone who has not used Docker much. Every command runs on the
Ubuntu box, not on the Mac.

## What Docker is doing here, in three sentences

An **image** is a frozen template — Node, the dependencies, and Bellwether's code
baked together. A **container** is one running copy of that image. Compose is a
file (`docker-compose.yml`) that records how to build the image and how to run
the container, so you type `docker compose up` instead of a paragraph of flags.

The important consequence: the container is disposable, but the archive is not.
`docker-compose.yml` mounts the host folder `./data` into the container at
`/data`, so the SQLite archive lives on the Ubuntu box's real disk. Delete and
rebuild the container as often as you like — the archive survives.

## One-time setup

### 1. Confirm Docker is there

    docker --version
    docker compose version

Both should print a version. If `docker compose version` errors but
`docker --version` works, you have the old standalone `docker-compose` binary —
use `docker-compose` (with the hyphen) everywhere below.

### 2. Get the code

    cd ~            # or wherever you keep projects
    git clone https://github.com/Ncomeaux3/bellwether.git
    cd bellwether

### 3. Create the environment file

`.env` is deliberately not in git — it holds secrets. Create it from the example:

    cp .env.example .env
    nano .env

Fill in `ANTHROPIC_API_KEY` by copying the value out of the `.env` on your Mac.
Leave everything else at its default for now. `BELLWETHER_DB` and
`BELLWETHER_EXPORT_DIR` are already correct.

Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`.

### 4. Check everything before starting anything

    docker compose run --rm bellwether doctor

This builds the image the first time, which takes a few minutes. Then it checks
your environment, the database, and every watched pricing page, and prints what
to fix for anything that fails. Run it until it is all green.

`--rm` means "throw the container away when the command finishes" — this is a
one-off check, not a service.

`git push` will report **not applicable** here. That is correct: publishing runs
on a machine with your GitHub credentials, not inside the container.

### 5. Start it

    docker compose up -d

`-d` means detached — it runs in the background and gives you your shell back.

## Checking on it

| What you want | Command |
|---|---|
| Is it running and healthy? | `docker compose ps` |
| What did it just do? | `docker compose logs --tail 20` |
| Watch it live | `docker compose logs -f` (`Ctrl+C` to stop watching) |
| Run a single step by hand | `docker compose exec bellwether pnpm bw collect` |
| Stop it | `docker compose down` |
| Start it again | `docker compose up -d` |

`docker compose ps` shows a STATUS column. You want `Up … (healthy)`. It reads
`starting` for the first minute, which is normal — the healthcheck asks "has any
pipeline step succeeded in the last 26 hours", and that is only true once the
first collection finishes.

Portainer will show the same container with the same health state, if you prefer
clicking to typing.

## Updating to a newer version

    cd ~/bellwether
    git pull
    docker compose up -d --build

`--build` rebuilds the image with the new code. Without it, Docker reuses the old
image and your changes appear to do nothing — this is the single most common
confusion when starting out.

## When something looks wrong

**`docker compose ps` says `unhealthy`.** No pipeline step has succeeded in 26
hours. Look at `docker compose logs --tail 40` for why. This is the alarm working,
not a bug in the alarm.

**It says `permission denied` on the Docker socket.** Your user is not in the
`docker` group:

    sudo usermod -aG docker $USER

Then log out and back in.

**The build fails on `better-sqlite3`.** The image compiles a native module. That
needs the build tools the Dockerfile already installs, so this usually means the
build ran out of memory. Give the box more swap, or build with
`docker compose build --memory 2g`.

**You changed code and nothing changed.** You rebuilt without `--build`. See
"Updating" above.

## What M1 actually does when it runs

On start it runs `migrate`, `seed`, `collect`, `export`, then idles. Collection
is gated to once per source per 24 hours, so restarting the container does not
re-fetch anything and never hammers the watched sites.

There is no scheduler yet — cron arrives in M5. Until then, one collection
happens per container start. To collect on demand:

    docker compose exec bellwether pnpm bw collect
    docker compose exec bellwether pnpm bw export

## Publishing from the homelab

`export --publish` commits and pushes the derived JSON, which needs a git
remote and a deploy key — the container deliberately has neither (it parses
adversarial third-party HTML every night and must not hold the one
credential that can push to the site). Publishing instead runs on the host,
outside the container, as its own step. See "Unattended publishing" below.

## Unattended publishing

M5 makes the box publish itself: the container writes guarded export
artifacts to `/data/export`, and a host-side script (`ops/publish.sh`) copies
them into the repo, commits, and pushes — using a deploy key that lives only
on the host, never inside the container.

### 1. Create a dedicated deploy key

Don't reuse your personal GitHub key. Generate one just for this repo:

    ssh-keygen -t ed25519 -f ~/.ssh/bellwether_deploy -N ""

### 2. Point an SSH host alias at it

Add this block to `~/.ssh/config` on the box:

    Host github.com-bellwether
      HostName github.com
      IdentityFile ~/.ssh/bellwether_deploy
      IdentitiesOnly yes

### 3. Rewrite the repo's remote to use the alias

    cd ~/bellwether
    git remote set-url origin git@github.com-bellwether:Ncomeaux3/bellwether.git

### 4. Add the public key to GitHub as a deploy key — with write access

Copy `~/.ssh/bellwether_deploy.pub` and add it under the repo's
Settings → Deploy keys, checking **Allow write access**. (Or, from a machine
with `gh` set up: `gh repo deploy-key add ~/.ssh/bellwether_deploy.pub --repo Ncomeaux3/bellwether --title bellwether-homelab --allow-write`.)
This is normally done from the Mac, since it needs your GitHub credentials,
not the box's.

### 5. Install the crontab

Replace any existing `collect && export` line with:

    0 7 * * * cd ~/bellwether && docker compose exec -T bellwether pnpm bw pipeline >> cron.log 2>&1; ./ops/publish.sh ~/bellwether >> cron.log 2>&1

Note the `;`, not `&&`, between the two commands. A partially-failed pipeline
(say, one degraded source) must still publish whatever passed the export
guards — `ops/publish.sh` has its own freshness precondition (it refuses to
run if `/data/export/board.json` is missing or older than 26 hours), so it
never publishes stale data even when it runs unconditionally.
