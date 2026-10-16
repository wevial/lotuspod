# LOTUS-193 review evidence

Both review findings are ADDRESS: wait for the publish/index notifications and
row swap before isolating Show older, and supply both visual captures.

Capture command (completed successfully: 1 passed):

```sh
CAPTURE_OUT="$PWD/e2e/capture/artifacts" .venv/bin/python -m tests.capture_site npm --prefix e2e exec --no -- playwright test --config e2e/capture/local.config.ts
```

- [After three publishes: 7 days, one event](artifacts/01-one-week-after-three-publishes.png)
- [After Show older and another publish: 14 days, two events](artifacts/02-two-weeks-after-another-publish.png)

Verification command (completed: 27 passed, 1 failed):

```sh
.venv/bin/python -m tests.capture_site npm --prefix e2e exec --no -- playwright test --config e2e/checks.config.ts e2e/checks/index-refresh.spec.ts e2e/checks/activity.spec.ts
```

The new regression and all three acceptance-criterion compatibility checks
passed. The separate grouped-page/filter check fails at activity.spec.ts:271:
its immediate group-order assertion sees an empty list after reload. Its helper
awaits HTTP responses, not rendered groups. This existing check is unchanged;
waiting for its rendered state is recorded as a follow-up.

Latest review adjudication: FOLLOW_UP for the existing grouped-page/filter
verification failure at `e2e/checks/activity.spec.ts:271`. The reviewer reproduced
the same failure on the frozen base (26 passed, 1 failed), while all acceptance
witnesses and both screenshots passed review. There are no ADDRESS items.
The required foreground verification command was run again to completion after
this review: 27 passed, 1 failed (the same grouped-page/filter check). Waiting
for rendered groups before checking their order belongs in a separate test
guardrail follow-up; this ticket leaves that existing check unchanged.
