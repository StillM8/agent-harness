# Future Improvements

This file tracks optional future improvements for `agent-harness` beyond the currently implemented lifecycle.

The project already implements the full supply-chain flow:

1. Discover
2. Mirror
3. Install
4. Activate

The suggestions below are refinements, enhancements, and operational improvements that can make the system more complete, more explainable, and more production-ready.

---

## 1. Universal official-upstream resolution

### Current state

- Many `officialskills.sh` entries already resolve toward repo-backed canonical sources.
- Not every official skill page is guaranteed to map to a fully resolved upstream artifact path yet.

### Why this matters

- Official indexes are useful for discovery, but repo-backed upstreams should remain canonical.
- Better upstream resolution improves mirror fidelity, provenance, and install quality.

### Suggested improvements

- Extract and cache upstream repo links from every `officialskills.sh` page.
- Persist owner/slug → repo mapping for reuse across runs.
- Fall back to repo search only when page-level upstream extraction fails.
- Prefer repo-native artifacts over metadata-only index entries everywhere.
- Track unresolved official index entries separately for follow-up.

---

## 2. Richer Copilot profile/workspace overlays

### Current state

- Activation is host-intent-aware.
- Overlay plans exist for OpenCode, Copilot, and shared runtime.
- Copilot activation is recommendation-informed and budget-aware.

### Why this matters

- Copilot benefits from smaller, more focused active sets.
- Richer workspace/profile overlays can significantly reduce context overhead.

### Suggested improvements

- Generate named Copilot profiles automatically from workspace evidence.
- Add per-workspace overlay manifests.
- Support stack-specific overlay modes such as:
  - frontend
  - backend
  - infra
  - security
  - docs
  - test
- Support task-mode overlays for focused sessions.
- Add session-intent-aware activation planning.
- Add profile diff and preview commands before switching.

---

## 3. Dedicated quarantine review workflow

### Current state

- Mirror routes risky assets into `mirror/quarantine`.
- Install skips quarantined entries.

### Why this matters

- Risk routing is more useful when it is reviewable and promotable.

### Suggested improvements

- Add `quarantine list` command.
- Add `quarantine inspect <assetId>` command.
- Add `quarantine approve` / `quarantine reject` workflows.
- Store review decisions and reasons.
- Add promotion path from quarantine to mirror-approved state.
- Record provenance and review timestamps for auditability.

---

## 4. Stronger community trust scoring

### Current state

- Trust scoring already uses authority, source type, docs/readme, stars, maintenance cadence, install method, and risk penalties.

### Why this matters

- Community sources vary widely in quality and safety.
- Richer trust scoring improves curation quality and recommendation accuracy.

### Suggested improvements

- Add commit recency and release cadence.
- Add contributor diversity signals.
- Add issue/PR health signals.
- Add security policy presence.
- Add test/workflow presence.
- Add license confidence and compatibility checks.
- Add signed release / provenance signals where available.
- Model endorsement signals from trusted indexes or official docs.

---

## 5. Better source classification and evidence-weighted parsing

### Current state

- Classification still relies partly on path-based heuristics.

### Why this matters

- Many ecosystems express skills, agents, and workflows differently.
- Better parsing reduces false classification and improves host-fit.

### Suggested improvements

- Add schema-aware parsing for known formats.
- Add frontmatter-driven classification where possible.
- Add repo-tree pattern recognition.
- Add source-family-specific classifiers.
- Add evidence-weighted asset-kind inference.
- Add confidence scores per classification decision.

---

## 6. Better remote harvesting resilience

### Current state

- GitHub PAT support exists.
- Rate-limit fallback to cache exists.
- Remote discovery is checkpointed.

### Why this matters

- Remote ecosystems are noisy and rate limits happen.
- Better resilience improves reproducibility and long-running rebuilds.

### Suggested improvements

- Add retry/backoff with jitter.
- Add source health reporting.
- Add per-source fetch failure counters.
- Add degraded-mode runs that skip unhealthy sources cleanly.
- Add fallback metadata paths for sources that fail REST API fetches.
- Add periodic refresh TTLs for cached remote snapshots.

---

## 7. Bundle explainability and reasoning reports

### Current state

- Selection reports and recommendation reports exist.
- Overlay plans exist.

### Why this matters

- Users need to understand why assets are selected, mirrored, installed, or activated.

### Suggested improvements

- Add `why selected` and `why rejected` explanations per asset.
- Add `why in bundle` explanation output.
- Add `why active now` explanation output.
- Add `bundle explain <bundleId>` command.
- Add provenance chain summary from discover → mirror → install → activate.

---

## 8. Better generation management

### Current state

- Deterministic install generations exist.
- Rollback exists.

### Why this matters

- Long-lived systems accumulate generations and need lifecycle control.

### Suggested improvements

- Add generation pruning policies.
- Add generation pinning / blessed generation support.
- Add generation diff command.
- Add rollback summary reports.
- Add generation validation and integrity checks.

---

## 9. Full diff/report commands across phases

### Why this matters

- Supply-chain style tooling benefits from visibility into what changed between runs.

### Suggested improvements

- `discover diff`
- `mirror diff`
- `install diff`
- `activate diff`
- report changes since last rebuild
- per-host bundle deltas
- recommendation delta reports

---

## 10. Better package-registry harvesting

### Current state

- Package registry sources exist in the source registry.
- Discovery is still GitHub-heavy.

### Why this matters

- Some important MCP servers and tools are better represented in package registries than repos.

### Suggested improvements

- Direct npm package metadata harvesting.
- Direct PyPI metadata harvesting.
- Direct Cargo / NuGet / Open VSX harvesting where relevant.
- Package → repo / docs reconciliation.
- Better package provenance and release integrity modeling.

---

## 11. Stronger activation planning

### Current state

- Activation is generation-aware, host-aware, recommendation-aware, and budget-aware.

### Why this matters

- Final runtime behavior is where context budgets matter most.

### Suggested improvements

- Session/task-intent-aware activation.
- Dynamic asset pruning by prompt budget.
- Workspace overlays tied to active repo characteristics.
- Split overlays by concern: frontend/backend/security/docs/test/etc.
- Profile-specific bundle routing for Copilot.
- Richer OpenCode global-harness vs task-harness activation choices.

---

## 12. Test suite and validation harness

### Current state

- The system is buildable and operational, but does not yet have a formal automated test suite.

### Why this matters

- Selection, trust scoring, dedupe, and activation logic benefit from regression tests.

### Suggested improvements

- Unit tests for selection rules.
- Unit tests for trust scoring.
- Unit tests for official index resolution.
- Integration tests for discover → mirror → install → activate.
- Golden tests for lockfile and overlay outputs.
- Validation harness for representative source families.

---

## 13. Performance optimization

### Why this matters

- Catalogs and mirrors can get large quickly.
- Rebuild performance matters for operational usability.

### Suggested improvements

- Lower-memory catalog processing.
- Parallel remote fetching where safe.
- Smarter incremental rebuilds.
- Better chunking for mirror/install/activate.
- Faster cache reuse and invalidation.

---

## 14. Promotion workflow for community assets

### Current state

- Community assets are catalog-only unless promoted by policy.

### Why this matters

- Promotion should be explicit, reviewable, and reproducible.

### Suggested improvements

- Promotion manifest file(s).
- Reviewed promotion history.
- Promotion diff view.
- Source-specific promotion confidence notes.
- Separate `community-stable` vs `community-experimental` promotion tracks.

---

## 15. Visual reports and dashboards

### Why this matters

- Large agent ecosystems are easier to manage with visual summaries.

### Suggested improvements

- HTML dashboard for source coverage.
- Trust distribution report.
- Active bundle composition dashboard.
- Mirror/install health dashboard.
- Generation timeline report.
- Quarantine summary report.

---

## 16. Better operating docs

### Current state

- README and implementation plan exist.

### Why this matters

- Operational clarity reduces misuse and drift.

### Suggested improvements

- “Fresh setup” guide.
- “Safe rebuild” guide.
- “Promote official source” guide.
- “Quarantine review” guide.
- “Rollback generation” guide.
- “How Copilot overlays are chosen” guide.

---

## Recommended priority order

If only a few future improvements are pursued next, the strongest order is:

1. Universal official-upstream resolution
2. Richer Copilot profile/workspace overlays
3. Dedicated quarantine review workflow
4. Stronger community trust scoring
5. Test suite and diff/explainability tools
