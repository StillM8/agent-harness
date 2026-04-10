# agent-harness

`agent-harness` is a dynamic, authority-aware asset supply chain for:

- OpenCode
- GitHub Copilot in VS Code

It separates the lifecycle of agent assets into four explicit phases:

1. Discover
2. Mirror
3. Install
4. Activate

The project is designed to keep agent tooling curated, reproducible, and context-efficient while preferring official sources over popularity.

## Why this exists

Modern agent ecosystems expose a huge number of skills, plugins, MCP servers, instructions, workflows, and agent definitions. Blindly installing everything creates three major problems:

- low-quality or duplicate sources pollute the runtime
- global activation exhausts context windows
- there is no deterministic path from discovery to active runtime state

`agent-harness` solves that by treating agent assets like a supply chain.

## Core principles

- **Official sources outrank stars**
- **Community sources remain catalog-only unless promoted**
- **Discover, mirror, install, and activate stay separate**
- **Mirror and install are deterministic and pinned**
- **Activation should be narrower than installation**
- **Recommendations should be evidence-driven, not brittle hardcoding**

## Architecture

### 1. Discover

Discovery finds candidate assets from:

- current workspace signals
- local generated sources
- official remote repositories and docs
- package registries such as npm and PyPI
- trusted community sources
- official skill indexes

Discovery outputs include:

- demand profile
- source index
- unified asset catalog
- selected catalog
- rejected catalog
- selection report
- recommendation report

### 2. Mirror

Mirror converts selected candidates into pinned, inert local references.

Mirror outputs include:

- mirror plan
- bundle locks
- raw mirrored artifacts
- mirror index
- mirror acquire state
- quarantine routing for risky assets

### 3. Install

Install projects mirrored assets into staged, host-specific package stores.

Install outputs include:

- staged packages for OpenCode
- staged packages for Copilot VS Code
- shared MCP install state
- bundle install manifests
- install progress state
- deterministic install generations

### 4. Activate

Activation materializes runtime views from installed generations.

Activation outputs include:

- OpenCode activation view
- Copilot activation view
- shared runtime activation view
- overlay plans
- generation-aware activation manifests
- Copilot workspace profile manifests

## Project structure

```text
agent-harness/
├── discover/
│   ├── source-packs/
│   ├── schema/
│   ├── output/
│   ├── sources.json
│   ├── selections.json
│   ├── pipeline.json
│   └── official-skills-indexes.json
├── mirror/
│   ├── audit/
│   ├── bundles/
│   ├── quarantine/
│   ├── raw/
│   ├── schema/
│   └── policy.json
├── install/
├── activate/
├── state/
├── src/
├── package.json
├── tsconfig.json
└── IMPLEMENTATION-PLAN.md
```

## Commands

### Build and validation

```bash
npm run build
npm run check
```

### Discover

```bash
npm run discover:demand
npm run discover:sources
npm run discover:catalog
npm run discover:select
npm run discover:stats
```

### Mirror

```bash
npm run mirror:plan
npm run mirror:locks
npm run mirror:acquire
```

### Install

```bash
npm run install:bundle
npm run install:reconcile
npm run install:reset
```

### Activate

```bash
npm run activate:host
npm run activate:reset
node ./dist/cli.js activate rollback --host opencode --generation <generation-id>
```

### Rebuild / operations

```bash
npm run rebuild:clean
npm run rebuild:full
```

### One-command workspace wrappers

From any target workspace, you can now run the full pipeline in one command.

#### VS Code / GitHub Copilot workspace

```bash
agent-harness-vscode --intent frontend
```

or from the project itself:

```bash
npm run workspace:vscode -- --intent frontend
```

#### OpenCode workspace

```bash
agent-harness-opencode --intent backend
```

or from the project itself:

```bash
npm run workspace:opencode -- --intent backend
```

#### Generic wrapper form

```bash
agent-harness workspace vscode --intent docs
agent-harness workspace opencode --intent security
```

These wrappers perform the full current pipeline for the target workspace:

1. demand profile
2. source index
3. catalog generation
4. canonical selection
5. mirror plan
6. mirror locks
7. batched mirror acquisition
8. batched install
9. install reconcile
10. activation
11. host wire-in apply

## Host wire-in

### VS Code / GitHub Copilot

The project now supports semi-automatic / automatic VS Code wire-in.

Supported integration behavior:

- updates **User-scoped** VS Code settings for protected AI path settings
- writes workspace-local `.github/copilot-instructions.md`
- materializes curated user-level runtime folders under `~/.copilot/agent-harness/`
- preserves the VS Code security boundary by avoiding workspace-level mutation of user-only settings

Commands:

```bash
agent-harness wire vscode --preview
agent-harness wire vscode --apply
agent-harness wire vscode --reset
```

Equivalent npm command:

```bash
npm run wire:vscode
```

Patched VS Code user settings can include:

- `chat.pluginLocations`
- `chat.agentSkillsLocations`
- `chat.hookFilesLocations`
- `chat.agentFilesLocations`
- `chat.instructionsFilesLocations`

Curated user-level runtime folders include:

- `~/.copilot/agent-harness/instructions`
- `~/.copilot/agent-harness/agents`
- `~/.copilot/agent-harness/skills`
- `~/.copilot/agent-harness/hooks`
- `~/.copilot/agent-harness/plugins`

Workspace-local export:

- `.github/copilot-instructions.md`

### OpenCode

The project now supports semi-automatic project-local OpenCode wire-in.

Supported integration behavior:

- writes a project-local overlay under `.opencode/context/project-intelligence/agent-harness/`
- updates a managed `AGENTS.md` section for the workspace
- does **not** overwrite the global OpenAgentsControl-managed install
- keeps the AGENTS.md change scoped to a managed begin/end section instead of replacing unrelated content

Commands:

```bash
agent-harness wire opencode --preview
agent-harness wire opencode --apply
agent-harness wire opencode --reset
```

Equivalent npm command:

```bash
npm run wire:opencode
```

### Automatic wire-in through workspace wrappers

The workspace wrappers now run wire-in automatically after activation:

```bash
agent-harness-vscode --intent frontend
agent-harness-opencode --intent backend
```

or:

```bash
agent-harness workspace vscode --intent docs
agent-harness workspace opencode --intent security
```

## Environment variables

### GitHub authentication

The GitHub client supports:

- `GITHUB_PERSONAL_ACCESS_TOKEN`
- fallback: `GITHUB_TOKEN`

Example PowerShell usage:

```powershell
$env:GITHUB_TOKEN = $env:GITHUB_PERSONAL_ACCESS_TOKEN
$env:AGENT_HARNESS_REMOTE_BATCH_SIZE = '120'
$env:AGENT_HARNESS_INSTALL_BATCH_SIZE = '250'
npm.cmd run rebuild:full
```

### Batch controls

- `AGENT_HARNESS_REMOTE_BATCH_SIZE`
- `AGENT_HARNESS_INSTALL_BATCH_SIZE`

These control checkpointed mirror acquisition and staged install throughput.

## Source authority model

The harness prefers sources in roughly this order:

1. trusted local generated sources
2. official first-party sources
3. official marketplaces
4. official-compatible sources
5. trusted community sources
6. unverified community sources

The important rule is:

> If an official vendor source exists, it outranks a more popular unofficial source.

## Dynamic recommendation model

Recommendations are based on live evidence such as:

- current workspace stack signals
- host compatibility
- source authority
- trust score
- risk
- context cost
- portfolio fit

Trust scoring currently incorporates:

- source authority tier
- source kind and priority
- publisher verification
- install method
- stars thresholds
- maintenance cadence
- readme/docs/frontmatter presence
- dependency declarations
- risk penalties

## Operational flow

### Standard full rebuild

```bash
npm run rebuild:full
```

This performs:

1. clean transient state
2. demand profile generation
3. source index generation
4. catalog generation
5. canonical selection
6. mirror planning
7. mirror lock generation
8. batched mirror acquisition
9. batched install
10. install reconcile
11. activation

### Session-intent-aware activation

Activation now supports a lightweight session intent signal:

```bash
node ./dist/cli.js activate host --intent frontend
node ./dist/cli.js activate host --intent security
node ./dist/cli.js activate host --intent docs
```

This biases activation ordering toward assets whose ids and capabilities align with the requested session intent.

The same intent can be used through the one-command wrappers:

```bash
agent-harness-vscode --intent frontend
agent-harness-opencode --intent security
```

### Clean reset only

```bash
npm run rebuild:clean
```

### Install state reset only

```bash
npm run install:reset
```

### Activation reset only

```bash
npm run activate:reset
```

## Current refinement boundaries

The lifecycle is implemented end-to-end. The remaining work is refinement rather than missing architecture, for example:

- broader upstream resolution for every official index item
- richer session/workspace-intent-aware activation planning
- more advanced quarantine routing and policy enforcement

## Documentation

For the current implementation details and roadmap, see:

- [`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md)

## License

This project is licensed under the MIT License. See [`LICENSE`](./LICENSE).
