# Outreach: demo videos for govt coaching/skilling programmes

## Status (29 Oct 2026)
- Contact research: **blocked**. The session network policy blocks `*.gov.in` hosts, so no official emails could be verified. `contacts.csv` has department rows only; no addresses were invented.
- Email automation: built and dry-run tested (`outreach.py`).

## What is confirmed (news reports only; no PIB release or circular found yet)
- 15 Aug 2026, Independence Day speech: free online coaching for competitive exams, and AI skills training for 1 crore youth within a year.
- No official source found for: budget, ministry list, exams covered, platform, launch date, EOI/tender. Do not state these in emails.
- Related existing programmes (possible fit, not confirmed as part of this plan): SATHEE (MoE with IIT Kanpur), YUVA AI for ALL (MeitY, Nov 2025), PMKVY 4.0.
- Sources: [France24](https://www.france24.com/en/live-news/20260815-india-s-modi-woos-youth-with-free-coaching-ai-training-1), [The Week](https://www.theweek.in/news/education/2026/08/24/online-coaching-india-exam.html), [PM India](https://www.pmindia.gov.in/en/news_updates/pm-announces-ai-skilling-of-1-crore-youth-in-one-year/) (search snippet only).

## Procurement routes (to check on the official sites)
- GeM: seller registration needs an authorised person with Aadhaar/PAN; content services would sit under service-provider categories (category not confirmed). Check gem.gov.in.
- NSDC / Skill India Digital Hub: no public empanelment steps found; partnerships so far are MoUs. Ask via NSDC's official partner page.
- DIKSHA VidyaDaan: open call for individuals/organisations to contribute e-learning content (grades 1-12). Closest real route for the school demos.
- MeitY: empanelment (not tender) is planned for government AI procurement, not skilling content.
- BHASHINI: no partnership process found.

## To finish the contact sheet
Allow these hosts in the environment's network settings, then rerun the research: `pib.gov.in`, `india.gov.in`, `meity.gov.in`, `education.gov.in`, `msde.gov.in`, `labour.gov.in`, `financialservices.gov.in`, `indiapost.gov.in`, `indianrailways.gov.in`, `nsdcindia.org`, `skillindiadigital.gov.in`, `gem.gov.in`, `diksha.gov.in`, `bhashini.gov.in`.
Fill a row only from an official page, put the page in `source_url`, then set `verified=yes`.

## Using the sender
1. Copy `config.example.json` to `config.json` (git-ignore it); set the SMTP password in env `OUTREACH_SMTP_PASSWORD`. Send from your own domain with SPF/DKIM.
2. `python3 outreach.py send` is a dry run. `--live` sends, max `daily_limit` per day, 20 s apart.
3. `python3 outreach.py followups --live` sends one follow-up after 7 days.
4. When someone replies "unsubscribe": `python3 outreach.py optout their@address`.
5. `send_log.csv` records every live send. Rows not verified, opted out, or missing fields are skipped.

Before sending: add the "AI-assisted demo" line to each video, get Hindi and fact review, and confirm Eastern Railway RPF deck permission.
