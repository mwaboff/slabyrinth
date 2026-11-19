# Releasing

Releases are built by `.github/workflows/release.yml` when a tag `vX.Y.Z` is pushed. The app's update
notice reads GitHub's *latest release* (drafts and prereleases excluded) and shows its notes under
"What's new", so the notes matter.

1. **Bump the version** in `apps/desktop/package.json` (the workflow refuses a tag that doesn't match it).
   Keep the root `package.json` in step.
2. **Update `CHANGELOG.md`**: move the `[Unreleased]` entries into a new `## [X.Y.Z] - YYYY-MM-DD` section,
   written for users (what they can do now, what got fixed), and update the link references at the end.
   That section becomes the GitHub Release body; without one, GitHub's generated notes are used instead.
3. Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`, then commit.
4. **Push the tag**: `git tag vX.Y.Z && git push origin vX.Y.Z`. A tag with a `-` (`v0.3.0-beta.1`) is
   published as a prerelease, which the update notice never offers.

The workflow tests, builds and packages on Windows (NSIS installer + portable exe) and Linux (AppImage),
runs a packaged smoke test, then publishes the release with the artifacts.
