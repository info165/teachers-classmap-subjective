# Handover: West Bengal government fund & tender tracking

## What I'm doing / for whom
I run a small team that makes short animated **explainer / e-learning videos** (English + Hinglish).
I want to find where the **West Bengal government** has money **allocated or approved but NOT yet put
out to tender**, by detailed field, so I can approach the department before procurement starts and
offer to produce the content. (If it's already tendered, it's too late for me.) Secondary interest:
a list of **fresh tenders in the last ~30 days** as a demand signal only.

## Where the earlier work lives
GitHub repo `info165/teachers-classmap` (remote may show as `teachers-classmap-subjective`),
branch `claude/loving-thompson-y6e94n`, folder **`fund-radar/`**:
- `SOURCES.md` — every source, by fund stage, with reachability.
- `taxonomy.md` / `taxonomy.csv` — 29 fund heads across school/higher/skilling/exam-prep/allied depts,
  with content-business fit scores (★★★ = e-content/courseware = my core).
- `wb_education_detail.md` — the detailed WB numbers so far (read this first).
- `opportunities.csv` — the output model (one row per fund line; `tender_found=no` = open gap).
- `fresh_tenders.csv` — the last-30-days tender reference table.
- `README.md` — system design + the access routes.

## West Bengal context (verify, don't re-assert)
New state government formed 9 May 2026; first full budget presented 22 June 2026 by FM Dr. Swapan
Dasgupta. School Education = **Demand No. 15**. Because the govt is new, much 2026-27 money is fresh
and pre-procurement — the good window.

## The best "funded, not yet tendered" leads to chase (all cited in wb_education_detail.md)
- **ADB "Enhancing School Education in WB" — ₹2,349.78 cr** (70% ADB), ~430 schools, smart
  classrooms/labs/digital; in-principle approval → no tenders yet.
- **Larger ADB package — ₹4,648 cr** (secondary ed + ICDS, incl. teacher training), approved Mar 2026.
- **PM SHRI** — WB joined (MoU 15 May 2026), AWP&B ~₹2,773 cr, just starting.
- **Bengal AI Mission** — announced in budget, covers education, brand new.
- **ADB ICDS modernisation — ₹2,148 cr**, 50,000 early-ed centres.
Per-school grant norms (Samagra Shiksha): e-content/digital **₹0.38 lakh/school recurring** (my core
fit), smart classroom ₹2.40 lakh, ICT lab ₹6.40 lakh, Atal Tinkering Lab up to ₹20 lakh/lab.

## Immediate task: pull the primary docs and extract line-item splits
I need the object-head splits (how much is "digital content / e-content" vs hardware vs training).
Pull these and extract every scheme/sub-head with its figure:
1. WB Budget Speech 2026-27 — `https://finance.wb.gov.in/writereaddata/Budget_Speech/2026-2027_English_I.pdf`
2. WB **Detailed Demands for Grants, Demand 15 (School Education)** — finance.wb.gov.in → Budget Publications
3. Samagra Shiksha **PAB minutes, West Bengal, latest** — dsel-education.gov.in / SE-Shagun (ICT, smart
   class, vocational, teacher-training approvals per component)
4. WB **PM SHRI** sanction / AWP&B — dsel-education.gov.in
5. **CAG WB State Finance report** — agwb.cag.gov.in (unspent balances / pending UCs = the "unutilized" story)
6. **wbtenders.gov.in** — search School Education, Higher Education, Technical Education, Madrasah Edu by
   keywords: "interactive panel", "smart class", "e-content", "digital content", "e-learning", "LMS",
   "courseware", "video". Log hits in `fresh_tenders.csv`; the heads with money but NO tender hit go to
   `opportunities.csv` as open gaps.

## Access — this matters
A cloud session CANNOT reach these: datacenter IP, no browser → `finance.wb.gov.in`, `pfms.nic.in`,
`cag.gov.in`, `dsel-education.gov.in` reset or block it, and spoofing a browser is not allowed.
`wbtenders.gov.in` responds but needs a real browser (session/captcha). So use ONE of:
1. **Claude desktop app + connect your computer (Remote Control)** — share a **git-repo-root folder on a
   Mac/Linux** machine, keep the app running. Then commands run on YOUR machine/IP and can download the
   PDFs. (Windows folders don't work for this route.)
2. **Built-in browser / Claude in Chrome** — open the links above in your real browser; works on any OS,
   you solve any captcha. Best if on Windows.
3. **APIs/bulk for budgets only:** data.gov.in (has API), OpenBudgetsIndia (CSV/XLSX). wbtenders / CPPP /
   PFMS have NO open API → browser only.

## Output model (opportunities.csv)
`id, state, department, sub_field, scheme, fund_stage(requested|incoming|available|unutilized),
fy, amount_inr, status, as_of_date, source_url, source_type, evidence_quote, confidence, matched_filter,
tender_found(yes|no)`. Open gap = funded AND `tender_found=no`.

## Rules (keep me honest)
- **Never invent a figure.** Every amount needs a source URL + evidence quote. Blank if unverified.
- Headline/scheme numbers are solid; **object-head splits only come from the primary PDFs above.**
- **"Unutilized" is the shakiest claim** — CAG lags ~1 year, PFMS is freshest. Pitch departments on
  active allocations I can evidence to the line-item; treat "unspent funds" as a conversation to confirm,
  not a number to put in writing unless CAG/PFMS states it.
- Before any outreach: add the "AI-assisted demo" line on videos, get subject-expert + Hindi review,
  confirm I may use the Eastern Railway RPF deck externally, and no official emblems/endorsement wording.

## First step for the new chat
Ask me which access route I'm using (desktop + Mac/Linux folder, or browser). Then pull doc #1 (WB budget
speech) and #2 (Demand 15 DDG), extract the School Education scheme/sub-head table into opportunities.csv,
and flag which heads have no matching wbtenders tender.
