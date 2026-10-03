# ClassMap · Tulna application handover (team copy)

Status date: 2026-10-03. This is the state of the product as checked in this session.
Read the readiness section before sending anything.

## 1. Readiness verdict

**Not ready to submit as "100% ready".** The core flows work on the demo school. Several
things are unverified or missing, listed below. Fix or disclose them before the application.

### Student app (classmap-student.web.app)
| Area | Status |
|---|---|
| Login (managed school login), dashboard, Academics list | Verified live |
| Multiple-choice test, results with bank letters and explanations | Verified live |
| Case-based questions (passage + parts) in tests and results | Verified live |
| Board-only and teacher-pushed topics visible in Academics | Verified live after fix |
| Welcome tour, then contact pop-up (order fixed) | Verified live |
| True/false, fill-in-the-blank, assertion-reason | **Not verified live.** No demo topic found with true/false or fill-in-the-blank |
| Subjective answers: photo capture and upload | **Not verified.** Camera and file picker can't be driven in the test browser |
| Results for subjective and pushed-test submissions | Partly verified (one pushed test, multiple choice only) |
| Mobile layout | **Not checked** |
| Old attempts (before id fix) | 561 questions cannot resolve; new attempts are fine |
| Plaintext student passwords stored (`studentCredentials`) | **Known, deliberately kept** (your decision). Must be disclosed in the security section |
| Forgot-password email | **Not live**: no email sending configured |
| Hindi content | **Held out** of the merged bank |

### Teacher app (classmap-teacher.web.app)
| Area | Status |
|---|---|
| Home: My classes, Your teaching, Teach tomorrow | Verified live |
| Exams page (summary strip, needs-attention flags) | Verified live |
| Chapter & Tests: push a test, take test in class | Verified live (push, present) |
| Present view: multiple choice, figures, case passages | Verified live |
| Chapter analytics: Teach next card | Verified live. "Common mistakes" stays empty (no misconception tags yet) |
| Pushed test review (per question, explanations) | Verified live. **No per-student list or student written answers** |
| In-class review (clicker results) | **Not verified** (navigation was blocked in testing) |
| "Reteach this topic" | **Partial**: opens the chapter page; it does not push a retest for students who need help |
| Print / Hindi summary | **Not verified** in print preview |
| Chapter counts on My classes | **Not built** |
| Recent code (3 commits) | Deployed, **not yet pushed** to GitHub |

### Question bank (classmap-software.web.app), internal tool
| Area | Status |
|---|---|
| Combined ClassMap merged list (316 chapters, 78,765 published questions) | Live |
| Reviewer access, merged tab, English publisher questions | Reviewer merged tab **not verified**: needs admin login |
| Misconception tags | **0 of 2,093 sampled questions tagged.** Handover written; batch not started |
| Board explanation letters | Some explanations cite a letter that does not match the key. Content issue, not fixed |

### Data and content
- Hindi banks: held out. Confirm this is acceptable for the application.
- Board explanation letters: publisher content, flagged, not changed.
- Question counts: 78,765 published across classes 6–10, maths, science, English, social studies.

## 2. Links

### Share with Tulna / evaluators
| Purpose | Link |
|---|---|
| Student app | https://classmap-student.web.app |
| Teacher app | https://classmap-teacher.web.app |
| Admin app (school admin) | https://classmap-admin.web.app |

Confirm before sending: custom domains (teacher.classmap.in and similar) only if they point to the
same deployments and are approved by you.

### Do NOT share
| Link / item | Reason |
|---|---|
| https://classmap-software.web.app (question bank) | Internal content-review tool. Not part of the evaluated product |
| https://classmap-superadmin.web.app | Platform admin. Not for evaluators |
| https://classmap-hub.web.app | Not part of this application |
| Any "teachers-classmap" or older project (e.g. the one you asked us not to check) | Out of scope |
| Firebase console links, service account files, anything in `serviceAccountKey*` | Secrets and infrastructure |
| The repo folders and git remotes | Internal |

## 3. IDs and demo accounts

Use the demo school only for evaluation. Do not use real student data.

| Item | Value |
|---|---|
| Demo school id | `demo-school` (name: Demo School, board CBSE) |
| Firebase projects | `classmap-student` (student, teacher, admin apps); `classmap-software` (question bank, internal) |
| Demo admin | demo.admin@demo.classmap.in |
| Demo teacher | demo.teacher@demo.classmap.in (classes 6-A to 10-A, Maths and Science) |
| Demo students | 25 students, classes 6-A to 10-A, e.g. aarav.kumar@demo.classmap.in (class 6), tara.reddy@demo.classmap.in (class 9), atharv.tiwari@demo.classmap.in (class 10) |
| Demo reviewer | demo.reviewer@demo.classmap.in (question bank only; not for evaluators) |
| Demo passwords | **Do not paste in this document.** Share separately through a secure channel. Rotate after the evaluation |

Demo data notes for evaluators:
- Five extra submissions and clicker responses were added as dummy data for Class 10 Science.
  Some wrong answers in that dummy data are inconsistent. Tell evaluators it is demo data, or
  delete it before the evaluation.
- Demo school question mode is `merged` (own bank plus board bank).

## 4. Application field guide (fill from the Tulna form)

I could not access the Tulna form from this environment, so the field list below is a template.
Fill each field from the form, and use the answers in section 1 for status. Do not claim more
than section 1 supports.

| Form field (example) | What to write | Source |
|---|---|---|
| Product name | ClassMap | Brand |
| What it does | Helps teachers see what the class got wrong and what to teach next; students practise with CBSE-pattern questions | Sections 1–2 |
| Users | Students (6–10), teachers, school admins | Apps |
| Languages | English now; Hindi held | Section 1 |
| Demo or sandbox URL | Student, teacher, admin links (section 2) | Links |
| Test credentials | Demo accounts, passwords sent separately | Section 3 |
| Data storage | Mumbai, India (per in-app notice; verify the Firebase region before stating) | Settings page text |
| Security | Firebase Auth; plaintext student passwords stored for school admins (disclose) | Section 1 |
| Accessibility | Text size control and high contrast in all three apps | Verified in apps |
| Content source | ClassMap own bank plus board-practice bank; some explanations need review | Section 1 |
| Known limitations | Section 1 "Not verified / Not built" rows | Section 1 |

## 5. Before sending: must-do checklist
1. Run the live checks in section 1 that say "Not verified" (true/false, fill-in-the-blank,
   assertion-reason, subjective photo upload, in-class review, mobile).
2. Push the three teacher commits (`d018e7f`, `f359494`, `e10afaf`) and deploy-check the live site.
3. Decide on plaintext passwords: disclose, or move to hashed credentials, before the evaluation.
4. Decide the Hindi position and say so in the form.
5. Confirm the links in section 2 open for the evaluator (not blocked by login walls that they
   can't pass with the demo accounts).
6. Remove or clearly label the dummy Class 10 submissions.

## 6. Open decisions for you
- Plaintext student passwords: keep and disclose, or change?
- Misconception tags: run the batch before Tulna, or present "common mistakes" as coming soon?
- Reteach: build a real retest for students below 60% before Tulna, or present it as the chapter page?
- Hindi: held out, or in?
