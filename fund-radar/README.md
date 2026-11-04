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
See `taxonomy.md` / `taxonomy.csv` for the full field-head list; tick the rows you can deliver.

## Primary output: OPEN gap (funded, NOT yet tendered)
This is the target. A head is an **open opportunity** when:

    allocated/approved (DDG, PAB, scheme release)  AND  no matching live/closed tender found

So the pipeline cross-references the allocation side (budget/PAB/scheme) against the tender side
(wbtenders, GeM, CPPP, WTL, aggregators) and surfaces the **difference**: money is there, no tender
yet → you can approach the department before procurement. `opportunities.csv` flags these
`fund_stage = available|incoming|requested` with `tender_found = no`.

## Secondary output: fresh tenders, last 30 days (reference only)
A separate table (`fresh_tenders.csv`) of tenders created in the last month — not to bid on (too
late for shaping), but as a demand signal showing which fields/departments are actively buying,
so you know where budgets are real and moving.

Caveat on the gap: much school money flows as per-school grants (ICT, smart class, ATL) that
thousands of schools spend individually, sometimes without a central tender. "Not tendered" at
state level can still mean district/school-level buying. The cleanest open gaps are **new scheme
heads** (PM SHRI in WB, Bengal AI Mission, AVGC labs, free-coaching content) where procurement
hasn't started at all.

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

## Access — how to actually reach the gov portals
This cloud session is the wrong machine for scraping Indian gov portals: it has a datacenter IP and
no browser, so `finance.wb.gov.in`, `pfms.nic.in`, `cag.gov.in` and `dsel-education.gov.in` reset or
block the connection, and faking a browser is not allowed. `wbtenders.gov.in` is reachable but needs
a real browser (session/captcha). Better routes, in order:
1. **Claude desktop app + connect your computer (Remote Control), or the built-in / Chrome browser.**
   This drives *your* real browser on *your* IP, which these sites accept. It can open the budget
   PDFs, PAB minutes and the wbtenders search (you solve any captcha). Best for reading + one-off pulls.
2. **A small scraper on your own machine / a normal-IP server** for the daily automation.
3. **APIs / bulk data where they exist:** data.gov.in (budget datasets, has an API), OpenBudgetsIndia
   (downloadable CSV/XLSX). Note: NIC eProcurement (wbtenders/CPPP) and PFMS have **no open API** —
   those need browser scraping. So the architecture is: APIs/bulk for budgets, browser for tenders.

## Status
Source registry + design done. No scrapers written yet (can't test them while gov.in is blocked, and
the field filter isn't defined). Next step needs: (1) domains allowed, (2) your field filter,
(3) go-ahead on WB-Education-first.
