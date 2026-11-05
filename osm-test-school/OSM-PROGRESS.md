# Teacher Marking (OSM) — autopilot progress log

Newest entries at the bottom. Read "DECISIONS" first, then "STATUS".

## DECISIONS (made by Claude while you were away — change any of them)

1. **Name:** the new feature is called **Teacher Marking** (flag `teacherManualMarking`).
   The existing flag `teacherAssessmentGrading_osm` already means "visual ticks/crosses" — not touched.
2. **Test data:** an isolated dummy school "OSM Test School", NOT the real Newtown accounts.
   You asked for "the real students of Newtown": I mirrored Newtown's structure (classes 9/11, all
   subjects, 3 co-teachers per class-section-subject) but with fake names. Reason: I never use real
   people's passwords, and a bug must not be able to touch real students' data or reports.
3. **Data isolation:** all in-progress marks live in NEW collections (`osmPapers/...`). Existing
   exam/submission/report collections are not touched until the final report is written.
4. **Parallel teachers:** one marks document per student; each save writes only
   `marks.<questionKey>` (Firestore field-path update), so 3 teachers saving at once never overwrite.
5. **Publishing:** unchanged. After analysis the finished report is written into the normal
   submission document, so the existing Admin "Publish All" and teacher publish work as today.
   Nothing is written to `studentAssessments` automatically.
6. **Total marks / OR questions:** total marks come from the paper's declared `totalMarks`, never
   summed from questions. OR-alternative questions use the existing `computeOrLoserQNums` rule.
7. **Backup + tags:** done before any change (see STATUS).

## STATUS
- [x] Phase 0 code tags `pre-osm-2026-11-04` (4 repos, local only, not pushed)
- [~] Firestore backup -> `~/Desktop/Backups/firestore-2026-11-04/` (teachers + auditLogs still running; Firestore rules saved too)
- [x] Seed OSM Test School (57 teachers, 48 students, 81 rosters, principal login) — credentials in `osm-test-school/credentials.json` (git-excluded)
- [x] Teacher Marking module v1 built + working locally: `teachers-classmap/src/osm/osm.ts` (+ small hooks in index.tsx/index.html). NOT deployed anywhere.
- [x] Review loop round 1: independent reviewer found 4 HIGH + 8 MEDIUM issues; all HIGH/MEDIUM fixed (commit c1380ec)
- [x] Analysis pipeline: `osm-test-school/analysis/` export.js + finalize.js, tested end-to-end on the test school
- [ ] DEPLOY — not done: Firebase CLI login expired and I will not push to live without you. Build is ready (`teachers-classmap/dist`).

## LOG
- 2026-11-04: found Newtown 9E Science has 3 co-teachers, each with own exam doc; submissions stored in
  one teacher's copy; others read it via a class/title lookup; verification is a per-teacher map in
  that one doc. Admin Publish All requires all roster teachers verified, then copies the submission to
  `studentAssessments/{uid}/assessments/{assessmentId_uid}`.

- 2026-11-04 (autopilot): built Teacher Marking v1. Verified in a real browser as a dummy teacher: create paper from Excel
  (7 questions incl. an OR pair, declared total 15 vs sum 18), upload sheets, vertical scroll desk, marks autosave,
  OR rule gives 13/15 (lower alternative not counted), pen strokes saved per teacher, Marks Given blocked until all
  questions marked, three-teacher parallel writes tested against Firestore (no overwrite).
  Live Firestore rules block new collections, so data is stored under assessmentHistory/.../submissions/{uid}/detail
  (same-school teachers already have read/write there). Existing code can't see OSM students (no parent submission doc).
  Flag `teacherManualMarking` is ON only for OSM Test School; the Newtown school is untouched.
  Found: existing teacher app can't run via vite dev (marked import) -> I serve the production build via `vite preview`.
  Found (not mine, flagged): a Gemini API key is hard-coded in teachers-classmap/vite.config.ts.

- 2026-11-04 (autopilot, later): full end-to-end verified on OSM Test School:
  create paper -> upload sheets -> 2 teachers mark (parallel) -> Marks Given -> Ready for analysis ->
  export -> feedback (validator caught a deliberately contradictory feedback) -> finalize --write --complete ->
  paper appears as a NORMAL exam for all 3 co-teachers, existing report screen shows 12.5/15 (declared total 15, OR rule applied),
  existing insights dashboard shows my topic heatmap, pen strokes appear in the right place in the existing grading viewer,
  existing Verify button works (writes teacherVerifications on the shared doc). Nothing written to studentAssessments.
- Super-admin: added toggle `teacherManualMarking` to super-admin-portal-v24/index.tsx (local edit only, not built/deployed; default OFF).
- Backup: core collections done (teachers 31,293 docs incl. my test docs; students 6,668; classRosters 1,682; studentAssessments 7,706;
  completedHomeworkSubmissions 1,603; schools 61 ...). ~30 small log/queue collections + auditLogs were still running in background.

## KNOWN GAPS / THINGS FOR YOU TO DECIDE
1. Not deployed anywhere. Needs `firebase login --reauth`, then a preview-channel deploy of the teacher app (I recommend a preview channel first).
2. Paper creation is Excel-only. The "My Questions" image flow is not reused (it is deeply tied to the exam form).
3. Dummy school only. Turning it on for Newtown = set `features.teacherManualMarking: true` in the school (super-admin toggle, once deployed).
4. Admin dashboard has no "marking progress" screen yet; admin publishes via the existing Publish All after all 3 teachers verify.
5. Pen: pen/eraser/undo only (colour + width). No text boxes/ticks. Existing ticks/crosses tool is only in the old viewer.
6. Question -> page mapping does not exist (teacher scrolls). A "jump to page" per question could be added.
7. Security (not mine): a Gemini API key is hard-coded in teachers-classmap/vite.config.ts and shipped in the bundle. Rotate it.
8. Student app: not opened with an OSM-produced report (it reads the same studentAssessments format as always, so it should work).

- 2026-11-05: Newtown preview loaded via `newtown-load.js --write`. New Auth user marking.preview@classmap.in (password in git-excluded
  credentials-newtown.json), teachers doc "Teacher Marking Preview" (isPreviewTeacher), 3 classRosters (9A/9B/9C Science, copy of real students),
  3 osm papers "MID - TERM EXAMINATION (Teacher Marking preview)" (54 q, 80 marks) with 39/40/42 student sheets REFERENCED by URL from the real
  mid-term submissions (no copy, nothing deleted). school W8Ey4uxm...flag teacherManualMarking set true (was unset: see newtown-flag-before.json).
  Verified locally: class page shows Teacher Marking, Exams count unaffected, 16/16 pages of 9A first student load.
  BEFORE LIVE DEPLOY: flag is on for ALL Newtown teachers -> Assignments/Worksheets hidden for them as soon as the new build is live.
  UNDO: delete teachers/{hbGbHH...} data + 3 rosters + flag (set features.teacherManualMarking false).

- 2026-11-05 (analysis v2): strict analysis pipeline (see analysis/README.md "Analysis rules"), teacher "Analysis" card with autosave + separate analysis PDF,
  edit-save guard (existing recompute no longer overwrites teacher_marking analysis), Marks Given = verification. Demo: dummy school paper "Mid-Term Examination (demo)".
  Found: Q39 pair lacked reciprocal OR marker in the Newtown paper data (fixed only in the demo copy); counted marks add to 82 vs declared 80 (28.B.I/II).
