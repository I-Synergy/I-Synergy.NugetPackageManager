# SonarCloud Remediation

Status: DONE
Started: 2026-10-30
Completed: 2026-10-30

## Steps
- [x] Add `.sonarcloud.properties` and remove the scanner/token requirement
- [x] Harden the GitHub Actions workflows (npm ci scripts, no npx, pinned action)
- [x] Fix the scoped product findings (269)
- [x] Reduce every cognitive-complexity hotspot to the rule threshold
- [x] Deduplicate the test and host-api blocks
- [x] Apply automatic date-based release versioning from the AI repo
- [x] Run `npm run quality` — PASS
- [x] Run `.ai/tests/run-all-tests.sh` — 11/11
- [x] Commit after review (local only)

## Notes

- SonarCloud still analyses the last pushed commit. The next push re-scores the
  project; the local SonarJS run is clean, and the analysis scope now excludes the
  AI templates and docs.
- `package.json` keeps its last published version. `release.yml` overrides it at
  build time with the UTC build number and never commits the change.
