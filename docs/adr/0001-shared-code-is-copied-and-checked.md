# 1. Shared code is copied into each repo, and a test keeps the copies equal

Date: 2026-11-16

## Context

The tools (this Scanner, the Tokenized RWA Tracker, Crypto Fundamentals) are separate repos with
no build step, and each deploys on its own. Some code is the same in more than one of them: the
flows core (Portal client, run loop, ledger, freshness rule), the build's fetch helper, and small
browser helpers (HTML escape, money and date formatting). The copies had drifted: fixes landed in
one repo and not in the other.

Options weighed: (a) each repo keeps a copy and a test fails when the copies differ; (b) one small
shared repo that each tool's Action pulls in; (c) browser helpers served from the site.

## Decision

Option (a), for build code and for browser helpers.

- A shared file lives in every repo that uses it, byte for byte the same.
- This repo is the source for files shared with the RWA Tracker. A change is made here first, then
  copied.
- Each repo has a test that fails when its copy differs from the recorded content of the shared
  file (a hash list kept next to the files), so drift is seen on the next test run.

## Why

- Repos stay independent: a tool builds, tests and deploys with nothing but its own checkout.
- No build step and no new repo to keep alive.
- Each tool stays testable on its own, in Node, with the helpers it ships.

## Consequences

- A change to a shared file is two commits (one per repo). The test says when the second is missing.
- The same rule covers the site's header and footer: plain HTML in every page, written by a sync
  script, with a test that fails when a page differs.
