<!-- The canonical app README template — align it with your CCoE rules.
     14 sections, in this order. A section with nothing to report = `None`
     (never deleted). Copy into <app>/README.md and fill it in. -->
# <app-name>

## Overview
<!-- What, for whom, the scope — 3 lines. No marketing pitch. -->

## Getting started
<!-- bootstrap, seed, the end-to-end demo:
chmod +x bootstrap.sh && APP=<app-name> ./bootstrap.sh
gitlab-ci-local --force-shell-executor        # ACTION=start|stop|purge
bun run seed && bun run demo -->

## Design vocabulary
<!-- The core theme (the default) or a justified choice. The
     custom components owned deliberately (outside the daisyUI kit) listed and
     justified here. -->

## Code language
<!-- fr | en — one single choice for the business identifiers. -->

## Tested critical paths
<!-- The journeys covered in integration/e2e, named. They are the ones
     the "no % threshold" doctrine requires covered.
     The test personas (idp/seed-test-users.sh): for each, the username
     <app>-test-<persona>, its scenario, and where the shared password lives
     (secret/<app>/test-users). -->

## Performance
<!-- The 100–350 ms endpoints justified; the endpoints switched to
     202/polling; the p99 measured from the logs. -->

## Personal data register
<!-- The columns, the purpose, the retention, the erasure. None if
     there is no PII. If the app tracks navigation (ANALYTICS_SITE=1), say
     what Umami collects and the value events sent. -->

## External data sources
<!-- One line per third-party source consumed in pull:
     source → the URL of its terms/licence → the attribution required → the
     real publication step → the cache TTL → the fallback (a warm cache /
     fixtures) → the secret path where applicable. None if the app
     consumes no third party. -->

## Exposed interfaces
<!-- REST /api/v1 (the default); WS / gRPC where applicable, with the
     measured criterion. -->

## LLM FinOps
<!-- The vkey, the aliases used, the per-run budget — if it is
     agentic, otherwise None. -->

## Durable workflows
<!-- If the app runs durable workflows, otherwise None:
     the namespace + task queues; the workflow types and, for each, WHAT IT
     WAITS FOR and WHAT IT COMPENSATES; why the engine was needed rather than
     the Stream alone; the VERSIONING POLICY for a deploy with runs
     in flight. Those last two are what a reviewer cannot
     reconstruct from the code. -->

## Libraries outside the recommendations
<!-- lib → what it brings → its cost. None if the stack is 100 %
     recommended. -->

## Structuring decisions
<!-- Lightweight ADRs: 3-5 lines per decision (context → choice →
     consequence). -->

## CCoE waivers
<!-- Granted, justified, dated, with an expiry. None otherwise. -->
