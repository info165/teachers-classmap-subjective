# Fund-Radar — state government fund opportunity tracker

Find, per **state × department × detailed field**, where public money is
**requested / coming / available / unutilized / being tendered**, so we can approach the
right department with the right demo before or during their procurement.

See `SOURCES.md` for the verified source registry. This file is the system design.

## Data model (`opportunities.csv`)
One row per fund line found:

`id, state, department, sub_field, scheme, fund_stage, fy, amount_inr, status, as_of_date, source_url, source_type, evidence_quote, confidence, matched_filter`

- **sub_field** = the detailed field (e.g. `interactive_panels`, `tinkering_labs`, `smart_classroom`,
  `e_content`, `teacher_training`, `vocational`) — this is what your filter matches on.
- **fund_stage** = `requested | incoming | available | unutilized | active_tender`.
- **amount_inr** = only a figure that literally appears in the source; else blank. Never invented.
- **confidence** = `verified` (seen on official page) | `reported` (aggregator/news) | `needs_check`.
- **evidence_quote** + **source_url** = the proof, so every row is auditable.

## The filter (your input)
You give a list of fields you can deliver (a taxonomy of keywords + synonyms per field). The
pipeline matches each found line-item against it, so you only see opportunities in your fields.
Example: `interactive_panels` ← "interactive panel", "IFPD", "LED touch panel", "smart board".

## Cadence (why per-source, not one daily sweep)
- **Daily:** tenders (wbtenders, GeM, WTL, aggregators) + GOs (wbxpress) — these move fast.
- **Quarterly:** PFMS releases / unspent balances.
- **Annual, date-triggered:** DDG budget (Feb–Mar), PAB minutes (Apr–Jul), CAG reports (on publish).

## Build plan
1. **WB-Education end-to-end first** as the template connector (sources above are all mapped).
2. Generalise the connector per state (each state portal differs → one adapter each; 28 states + 8 UTs).
3. Per department, reuse: budget-DDG parser, PAB parser, tender-search scraper, CAG parser.

## Honest constraints
- **Blocked now:** all `*.gov.in` return 403 at the proxy. Needs domains allowed (see SOURCES.md).
  Non-gov mirrors (PRS, OpenBudgetsIndia, dataful, WTL, aggregators) work and cover much of it.
- **Much is scanned PDF** → OCR, which is error-prone; figures must be human-verified before you act.
- **"Unutilized in real time" is the hardest** — CAG lags ~1 year; PFMS is the freshest signal.
  Active tenders are the most reliable "act now" signal.
- Each state = its own portal and layout → real effort to scale; that's why WB is built first as proof.

## Status
Source registry + design done. No scrapers written yet (can't test them while gov.in is blocked, and
the field filter isn't defined). Next step needs: (1) domains allowed, (2) your field filter,
(3) go-ahead on WB-Education-first.
