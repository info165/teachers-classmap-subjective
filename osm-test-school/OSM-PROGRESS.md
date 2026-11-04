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
- [ ] Review loop (self-critique + second agent)
- [ ] Analysis pipeline (run by Claude from chat)

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
