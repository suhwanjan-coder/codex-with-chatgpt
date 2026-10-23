# Example scope

`c2c.json` is historical upstream configuration (copy name: `.c2c.json`).
The hardened fork does not run the planning loop: `maxIterations: 12` does not
enable it or change review call/time limits. Use explicit `review prepare`
arguments and the [current operating guide](../docs/HARDENED_REVIEW.md).

`c2cignore.example` remains applicable: copy it to `.c2cignore` in the reviewed
repository before preparing a snapshot. Matching paths are rejected at preparation;
later ignore changes do not modify a prepared snapshot. Static sensitive/noise
rules still apply, and this fork also rejects `.env.example`. Ignore rules and
credential screening do not prove content is non-sensitive.
