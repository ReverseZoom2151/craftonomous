# Live testing

Everything else in this repository can be checked without a Minecraft server.
This part cannot. The mineflayer binding only tells the truth when there is a
world on the other end of the socket, so this page describes how to put one
there, how to run the first connect, sense and act loop against it, and what
tends to go wrong the first time.

## Read this first: the account rate limit

Mojang allows six session joins per thirty seconds per account, and a high
volume of authentication errors can itself suspend an account for roughly
twenty four hours. A reconnect loop pointed at a real account is therefore not
a slow test, it is a way to lose the account for a day.

The harness is built so this cannot happen by accident.

- The server in `docker/docker-compose.yml` runs in offline mode. No Microsoft
  account, no session server, no join quota.
- `scripts/smoke.mjs` and the live tests both refuse to start when
  `MINECRAFT_AUTH` is anything other than `offline`.
- Both make exactly one join attempt. Reconnect is switched off, so nothing in
  the harness can loop on connecting.
- The live suite connects once per file and reuses that connection.

If you ever do point this at an online-mode server with a real account, do it
by hand, once, and watch it. Do not put it in a loop and do not put it in CI.

## Bring the server up

Requires Docker with the compose plugin.

```
docker compose -f docker/docker-compose.yml up -d
```

The first start downloads the image, then generates a world, which takes a
couple of minutes. The container has a healthcheck that performs a real server
list ping, so wait on readiness rather than on a stopwatch:

```
docker inspect --format "{{.State.Health.Status}}" craftonomous-mc
```

That prints `starting` while the world is generating and `healthy` once the
server is accepting connections. To follow along:

```
docker compose -f docker/docker-compose.yml logs -f minecraft
```

To stop the server but keep the world:

```
docker compose -f docker/docker-compose.yml down
```

To throw the world away and regenerate it from the pinned seed, which is the
reset button after a test has dug a hole through the terrain:

```
docker compose -f docker/docker-compose.yml down -v
```

What the compose file pins, and why it matters here: the image tag is an exact
release, the Minecraft version is `1.21.4`, and the world seed is fixed, so the
terrain around spawn is the same on every machine. Difficulty is peaceful so a
bot standing still during an assertion does not get shot, the whitelist is off
so the offline-mode username is accepted, spawn protection is zero so digging
near spawn works, and the view distance is small so startup and joins are
quick.

## Run the smoke test

```
npm run build
node scripts/smoke.mjs
```

The smoke test runs against the compiled binding in `dist/`, so build first. It
connects once, prints one line per check, and exits non-zero on the first thing
that is broken. Every wait is time-bounded and the whole run is under a
watchdog, so it fails rather than hangs.

What it checks, in the order these things break:

1. It connects and spawns inside the spawn timeout.
2. Body state comes back with plausible values: finite position inside the
   world height range, health in `(0, 20]`, food and oxygen in range, a named
   dimension, and an eye position exactly one head above the feet.
3. Blocks read: the block below the feet exists, is solid, and reports the
   integer cell that was asked for.
4. Blocks outside the loaded chunks read as unknown rather than as an invented
   value.
5. Occlusion behaves: a ray from the eye into the ground is occluded, a ray to
   the sky is not occluded when the column above is clear, and both answers
   agree with a plain column scan through `blockAt`. For a vertical ray the
   blocks strictly between the endpoints are just the column, so the expected
   answer is computed without reusing the traversal being tested.
6. A movement actually changes the reported position. Several directions are
   tried, because the first one may be a wall.
7. Entities and inventory are readable, and the bot does not appear in its own
   entity list.
8. Disconnect is clean, leaves the port marked disconnected, and is idempotent.

Configuration comes from the same environment variables as the CLI:
`MINECRAFT_HOST`, `MINECRAFT_PORT`, `MINECRAFT_USERNAME`, `MINECRAFT_VERSION`
and `MINECRAFT_AUTH`. `SMOKE_TIMEOUT_MS` caps the whole run and defaults to
180000.

## Run the live tests

```
CRAFTONOMOUS_LIVE=1 npx vitest run --config tests/live/vitest.config.ts
```

On PowerShell:

```
$env:CRAFTONOMOUS_LIVE = "1"; npx vitest run --config tests/live/vitest.config.ts
```

Without `CRAFTONOMOUS_LIVE=1` every suite is skipped, and the normal
`npx vitest run` does not collect these files at all: the root config only
picks up `*.test.ts`, and live files are named `*.live-test.ts`. Two
independent mechanisms, either of which would be enough on its own, because a
live test that sneaks into CI fails on a machine with no server and teaches
everyone to ignore red builds.

The live tests import the TypeScript sources directly, so they do not need a
build. The smoke test does need one.

## What to expect the first time

The image download and world generation dominate the first run. After that a
cold start is a few seconds and a join is under a second.

The bot spawns wherever the seed puts spawn, which is outdoors on the surface,
so the ground under it is solid and the sky above it is usually clear. Usually,
not always: spawn can be under a tree. The occlusion checks are written to
compare against what `blockAt` reports rather than to assume open sky, so a
canopy overhead produces a note, not a failure.

The first movement is the slowest check. The pathfinder computes a route and
walks it, so allow tens of seconds.

Expect noise on stderr from mineflayer itself. It logs some connection errors
directly, and those lines are not the smoke test's own output. The lines that
matter start with `ok`, `FAIL` or `smoke test`.

## Troubleshooting

### Version mismatch between mineflayer and the server

Symptoms are an immediate disconnect, a kick that mentions an outdated client
or server, or an error naming an unsupported protocol version.

mineflayer 4.37 supports Minecraft 1.8 through 1.21.11. The compose file pins
the server to 1.21.4, which is inside that range and has data in the bundled
`minecraft-data`. If you change `VERSION` in the compose file, check it against
that range first.

By default the client auto-detects the version from the handshake, which is
usually right. When it guesses wrong, pin the client too by setting
`MINECRAFT_VERSION` to the same value as the server's `VERSION`. If you pin the
client to a version the server is not running, you get the same kick, so change
both together or neither.

### The server is not ready yet

`ECONNREFUSED` means nothing is listening. The container takes a while on first
start because it is generating a world, and the port is open only at the end of
that.

Wait for the healthcheck to report `healthy` rather than sleeping for a guessed
number of seconds:

```
docker inspect --format "{{.State.Health.Status}}" craftonomous-mc
```

A connection that is accepted and then dropped during login, rather than
refused, usually means the server is up but still loading spawn chunks. Give it
another moment and retry once. Do not retry in a loop.

### Offline versus online mode confusion

If the server has `ONLINE_MODE=TRUE` and the bot connects with
`MINECRAFT_AUTH=offline`, the join is rejected during login, often with a
message about failing to verify the username or about the client not being
authenticated. The reverse, a real account against an offline-mode server, also
misbehaves and is pointless besides.

For this harness both sides are offline: `ONLINE_MODE: "FALSE"` in the compose
file and `MINECRAFT_AUTH=offline` in the environment. The username is then just
a label, and the smoke test refuses to run in any other configuration.

If you have edited the compose file, remember that `OVERRIDE_SERVER_PROPERTIES`
rewrites `server.properties` on every start, so the compose file wins over any
change made inside the container.

### Port conflicts

If something else already listens on 25565, the container fails to start with a
message about the port being allocated. Move the host side of the mapping:

```
MINECRAFT_PORT=25566 docker compose -f docker/docker-compose.yml up -d
MINECRAFT_PORT=25566 node scripts/smoke.mjs
```

The same variable moves both the published host port and the port the client
dials, so they cannot drift apart. On PowerShell set `$env:MINECRAFT_PORT`
first, in the same shell for both commands.

Another common case is an old container from a previous run still holding the
port. `docker ps -a` will show it, and
`docker compose -f docker/docker-compose.yml down` removes it.

### Nothing moves

If the movement check fails while everything else passes, the usual cause is
that `mineflayer-pathfinder` did not load, in which case `moveTo` refuses with
`pathfinder is not loaded`. Reinstall dependencies and rebuild. The other cause
is genuine: the bot is boxed in, which the fixed seed makes unlikely at spawn
but not impossible after a previous test has been digging. Reset the world with
`down -v`.
