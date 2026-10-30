# Publishing to VS Code Marketplace

## Prerequisites

1. Create a publisher on [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage) (publisher ID: `I-Synergy`)
2. Generate a Personal Access Token (PAT) in [Azure DevOps](https://dev.azure.com/) with **Marketplace > Manage** scope
3. Add the PAT as a repository secret named `VSCE_PAT` (Settings > Secrets > Actions)
4. Optional: add `RELEASE_TOKEN` when the default `GITHUB_TOKEN` cannot push tags or create releases

## Automatic versioning

Versions are **not bumped by hand** — the same scheme as the I-Synergy/AI repo.
Every push to `main` runs `.github/workflows/release.yml`, which:

1. derives a UTC build number in the form `YYYY.1MMdd.1HHmm` (for example `2026.11030.1425`),
2. skips the run when the tag already exists,
3. sets that version in `package.json` for the run only (`npm version … --no-git-tag-version`),
4. runs the quality gate, packages the `.vsix` and publishes it to the Marketplace,
5. creates an annotated tag named after the build number (**no `v` prefix**) and a
   GitHub Release whose notes are generated from the commits since the previous tag.

`package.json` in the repository keeps its last published version; the release
workflow overrides it at build time. `main` is never modified, and no changelog or
release-notes file is committed.

To force a specific build (for example a retry), run **Actions > Release > Run workflow**
and pass `YYYY.1MMdd.1HHmm` as the build number.

## Quality gate

`release.yml` runs `npm run quality` before packaging. The same checks also run on every
push and pull request in `.github/workflows/quality-gate.yml`:

```bash
npm run quality            # build, lint (ESLint + SonarJS), type check, tests, npm audit
npm run quality:coverage   # same, and writes coverage/lcov.info
```

SonarCloud analysis is performed by its GitHub integration (automatic analysis); no
scanner or `SONAR_TOKEN` is required.

## Manual publish

A manual publish is possible but bypasses the automatic version:

```bash
npm run package                           # builds releases/nugetpackagemanager-x.x.x.vsix
npx @vscode/vsce login I-Synergy          # authenticate with PAT
npx @vscode/vsce publish --no-dependencies
```
