# Strapi parity report

Generated: 2026-05-24T00:53:31.893Z
Threshold: 10% pixel-delta budget
Total screens: 12 — pass: 10, fail: 2, incomplete: 0

Rows are sorted with `fail` and `incomplete` first so reviewers see problems immediately.

| Screen ID | Label | Similarity | Status | Notes |
|---|---|---|---|---|
| 08-media-upload-modal | Media library — upload modal | 85.90% | FAIL | structural divergence: Strapi's upload dialog uses tabs (From computer / From URL); hono-cms uses a single drop-zone surface. Both modals open from the same trigger. |
| 12-ct-add-field-modal | Content-Type Builder — add field modal | 88.49% | FAIL | structural divergence: Strapi's CT-builder opens a grid-picker dialog (string/text/email/...); hono-cms inserts an inline draft row. Both reachable via 'Add another field'. |
| 01-login | Login | 97.97% | pass |  |
| 02-dashboard | Dashboard / Home | 98.12% | pass |  |
| 03-content-list | Collection list (with rows) | 98.04% | pass |  |
| 04-content-list-filter-open | Collection list — filter chip open | 97.53% | pass |  |
| 05-record-edit | Record edit | 96.98% | pass |  |
| 06-record-edit-info-panel | Record edit — right info panel | 96.80% | pass | intentional divergence: hono-cms admin always shows the right info panel — no separate toggle state. Identical to screen 05 by design. |
| 07-media-grid | Media library — grid | 97.76% | pass |  |
| 09-settings-home | Settings home | 97.55% | pass |  |
| 10-api-tokens | API tokens list | 98.18% | pass |  |
| 11-ct-builder-form | Content-Type Builder (form view) | 98.08% | pass |  |
