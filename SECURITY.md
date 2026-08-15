# Security Policy

## Supported versions

Craftonomous is pre-1.0. Only the latest release and `main` receive security
fixes. Pin a version if you need stability, but expect to upgrade to receive
fixes.

## Reporting a vulnerability

**Please do not open a public issue, pull request, or discussion for a
security problem.**

Report privately, by either route:

1. **GitHub private vulnerability reporting** (preferred): go to the
   repository's **Security** tab and choose **Report a vulnerability**. This
   opens a private advisory visible only to maintainers.
2. **Email**: <tibi.toca@gmail.com>, with `SECURITY` in the subject line.

Please include:

- what the issue is, and what an attacker gains from it;
- the version, commit, or branch you tested;
- a minimal reproduction, and the configuration it needs (perception profile,
  server setup, MCP client);
- any mitigation you already know of.

You can expect an acknowledgement within 7 days and an assessment within 30.
We will tell you whether the report is accepted, keep you updated as a fix is
prepared, and credit you in the advisory unless you would rather stay
anonymous. Please give us a chance to ship a fix before disclosing publicly.

## Operator responsibilities

Some of the risk here is not a bug in the code. It is a property of what this
project does. Read this section before you run it.

### The MCP server hands game actions to an LLM

Craftonomous exposes Minecraft actions (movement, block breaking and
placing, inventory manipulation, chat) as MCP tools. Whatever model is
connected to that server decides when to call them, and it decides based on
text it reads from the world: chat messages, sign text, book contents, item
names, player names. All of that is attacker-controlled input on a server you
do not run.

Treat the model as an untrusted actor holding your bot's permissions. Prompt
injection through in-game text is not hypothetical; it is the obvious attack.

**Do not point Craftonomous at a server you do not control.** Run it against
your own local or private server, and specifically:

- Do not connect it to public multiplayer servers, other people's realms, or
  any world where griefing has a cost to someone else.
- Do not run it with an account that has operator privileges, and do not give
  it credentials worth stealing.
- Assume anything the bot can reach in the world may be destroyed, moved,
  dropped, or given away.
- Back up any world you care about before running against it.

### Credentials

`MINECRAFT_AUTH=microsoft` involves a real Microsoft account. Keep credentials
in a local `.env` (git-ignored) and never commit them. `.env.example`
documents the variables without values. Prefer `offline` auth against a local
server for development.

### Perception profiles are honesty settings, not security boundaries

`CRAFTONOMOUS_PROFILE=xray` and `omniscient` deliberately grant the agent
information a human player could not obtain. They exist for research and
ablation. They are not a sandbox escape and they are not a permission model.
They change what the agent is allowed to _know_, never what it is allowed to
_do_. Do not rely on `fair-play` as a safety control; rely on running against
a server you own.

## Scope

In scope: anything that lets a third party make the bot act outside its
declared perception budget or tool surface, credential leakage, remote code
execution through crafted server data, and reliability accounting that can be
silently falsified.

Out of scope: the bot behaving badly because a model told it to on a server
you chose to connect to, and vulnerabilities in Minecraft itself or in
upstream dependencies (report those upstream, though we appreciate a heads-up).
