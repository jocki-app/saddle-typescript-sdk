# Releases

This repository versions its package independently of the SADDLE wire format. Package `0.x` changes do not change the `SADDLE01` magic or `/1` document identifiers.

1. Run `npm ci && npm run check`.
2. Run `npm version 0.2.0 --no-git-tag-version` (substitute the chosen version). Review and commit `package.json` and `package-lock.json`.
3. Push the commit, then `git tag v0.2.0 && git push origin v0.2.0`.

`release.yml` refuses a mismatched tag, verifies the package and publishes a GitHub release with the installable npm tarball and SHA-256 checksums. It also builds libgit2 rename helpers for macOS Intel/Apple Silicon, Linux x64/arm64 and Windows x64; each archive includes licenses. Prerelease tags produce prereleases and use npm's `next` channel.

Registry publication is opt-in: create/claim the package namespace, configure an [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/) for owner `jocki-app`, repository `saddle-typescript-sdk`, workflow `release.yml`, environment `npm`, then set GitHub repository variable `NPM_PUBLISH=true`. No long-lived registry token is stored. Until configured, GitHub release tarballs remain fully installable with `npm install /path/to/package.tgz`.

Never move a published tag or replace a released package version. Fixes receive a new version. Restore a previous dependency version to roll back.
