# Fund-Radar source registry

Goal: for a given **state + department + detailed field**, find funds that are
**requested / coming from centre / available (allocated) / unutilized / being procured now**,
at line-item level (e.g. "interactive flat panels", "tinkering labs"), not just "₹X cr for education".

Reachability note (4 Nov 2026): every `*.gov.in` host tested returns a policy **403** at this
session's proxy, so nothing on those can be scraped until the domains are allowed in the
environment's network settings. Non-gov sources (PRS, OpenBudgetsIndia, dataful, WTL/Webel PSU,
tender aggregators) are the reachable fallback and mirror most of the same data.

Each source below: what it gives, which fund-stage it covers, format, cadence, and whether it is
reachable now. "stage" = requested | incoming | available | unutilized | active_tender.

---

## STAGE: AVAILABLE — what the department is allocated this year
| Source | Covers | Granularity | Format | Cadence | Reachable now |
|---|---|---|---|---|---|
| State **Detailed Demands for Grants (DDG)** — WB: finance.wb.gov.in → Budget Publications. School Edu = **Demand No. 15**; Higher Edu, Madrasah/Minority, Technical Edu are separate demands | Full allocation by scheme + object/detailed head | Line-item (object head) | PDF (often scanned → OCR) | Annual (Feb–Mar) | No (gov.in) |
| Budget at a Glance / Annual Financial Statement (WB: finance.wb.gov.in) | Dept totals, summary | Demand level | PDF | Annual | No (gov.in) |
| Dept budget pages, e.g. Higher Ed `banglaruchchashiksha.wb.gov.in/budget` | Dept-specific BE | Scheme/head | HTML/PDF | Annual | No (gov.in) |
| **OpenBudgetsIndia** `openbudgetsindia.org` | Budgets parsed by state/sector/scheme | Scheme/head | **CSV/XLSX** | Annual | Test (non-gov) |
| **PRS Legislative Research** `prsindia.org/budgets/states` | Analysed state budget, major heads/schemes | Scheme | HTML/PDF | Annual | Likely (non-gov) |
| **dataful.in**, indiastat (paid) | CSS releases, dept expenditure tables | Scheme | CSV/HTML | Varies | Likely (non-gov) |

## STAGE: INCOMING — central transfers / scheme approvals to the state
| Source | Covers | Granularity | Format | Cadence | Reachable now |
|---|---|---|---|---|---|
| **Samagra Shiksha PAB minutes** — `dsel.education.gov.in`, `dsel-education.gov.in`, SE-Shagun. Per-state approvals | ICT & digital, smart classrooms, vocational, libraries, KGBV, etc. | **Line-item per component** | PDF | Annual (Apr–Jul) + revised | No (gov.in) |
| **PFMS** `pfms.nic.in` | Scheme-wise releases to state agencies + balances | Scheme/agency | Dashboard + download | ~Real-time/quarterly | No (gov.in) |
| Scheme portals: PM-SHRI, PM eVidya, STARS, ULLAS (adult ed) | Scheme-specific outlays/approvals | Component | HTML/PDF | Annual | No (gov.in) |
| Union Budget "Transfers to States" / CSS outlays | What centre budgets per scheme | Scheme | PDF/CSV | Annual | Mixed |

## STAGE: REQUESTED — asked for, not yet received/spent
| Source | Covers | Format | Cadence | Reachable now |
|---|---|---|---|---|
| State **AWP&B proposal** to centre (precedes PAB) — state SSA mission (WB: PBSSM / Banga Shiksha) | The state's ask by component | PDF | Annual | No (gov.in) |
| State **budget speech + new schemes** (WB post-election → fresh budget & asks) | New programme announcements | PDF/news | Annual/ad-hoc | Mixed |
| **Government Orders / cabinet decisions** — `wbxpress.com` (aggregates WB GOs) + finance.wb.gov.in | Sanctions, releases, new schemes | PDF/HTML | Daily | wbxpress likely; gov.in no |
| **Legislative Assembly Q&A** | Allocations, sanctions, pending items | PDF | Session-based | No (gov.in) |
| **EOIs / pre-tender / RFP** on dept sites | Intent to procure | PDF | Ad-hoc | No (gov.in) |

## STAGE: UNUTILIZED — allocated but unspent (highest-value to approach)
| Source | Covers | Format | Cadence | Reachable now |
|---|---|---|---|---|
| **CAG State Finance Audit & performance reports** — `cag.gov.in`, `agwb.cag.gov.in` | Unspent balances, savings, surrenders, parked funds, pending UCs | PDF (detailed) | Annual | No (gov.in) |
| **PFMS** unspent balances / UC status | Per scheme/agency unspent | Dashboard | ~Real-time | No (gov.in) |
| Assembly Q&A / RTI / press on unutilized funds | Specific unspent lines | Mixed | Ad-hoc | Mixed |

## STAGE: ACTIVE_TENDER — being procured right now (sharpest signal)
| Source | Covers | Format | Cadence | Reachable now |
|---|---|---|---|---|
| **WB eProcurement** `wbtenders.gov.in` (official) | Live NITs by dept + keyword | HTML/PDF | Daily | No (gov.in) |
| **WTL / Webel** `wtl.co.in` (WB PSU, implementing agency) — hosts PBSSM smart-class tenders | Actual tender PDFs | PDF | Daily | **Test (non-gov)** |
| **GeM bids** `bidplus.gem.gov.in` | Central/state bids | HTML | Daily | No (gov.in) |
| **CPPP** `eprocure.gov.in` | Central public procurement | HTML | Daily | No (gov.in) |
| **Aggregators**: BidAssist, TenderDekho, TendersOnTime, Tendersplus, TenderDetail | Mirror gov tenders, searchable by state/dept/keyword | HTML | Daily | **Likely (non-gov)** |

---

## Verified WB-Education examples (from search, 4 Nov 2026 — confirm figures on official portal before use)
- School Education = **Demand No. 15** in WB Detailed Demands for Grants (finance.wb.gov.in budget publications).
- WB Samagra Shiksha **PAB minutes** exist per year on dsel(.education).gov.in — list ICT/smart-classroom approvals.
- Tender **WTL/PBSSM/SMART CLASS/25-26/029 (24.09.2025)** — LED interactive touch panels, OPS, MFP, UPS for smart classes, Banga Samagra Shiksha Mission (host: wtl.co.in).
- Madrasah Education tender — **300 Govt/aided madrasah smart classrooms + 100 smart labs**, 75" 4K interactive panels with OPS.
- Directorate of Technical Education tender — interactive panels, Raghunathpur Govt Polytechnic, est. **₹7,20,000** (closed Feb 2026).
- PRS 2026-27 WB analysis: Samagra Shiksha allocation **₹3,000 cr**; assistance to non-govt secondary schools **₹20,936 cr**.

Sources: prsindia.org, finance.wb.gov.in, dsel.education.gov.in, wtl.co.in, openbudgetsindia.org, cag.gov.in, dataful.in.
