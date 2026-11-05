# Running the Teacher Marking analysis (done by Claude, from chat)

1. Teachers mark on screen → each clicks **Marks Given** → the paper shows **Ready for analysis**.
2. Tell Claude: "Analyse Class 9 A Science — Unit Test 1 for <school>."
3. Claude runs `node export.js "<School>" <class> <section> <subject>` (read-only): exports each READY student's
   teacher marks + page images into `work/…/`. Students not ready are listed and skipped.
4. Claude reads the handwriting and the teachers' marks and writes `work/…/feedback/<roll>.json`
   (one feedback per question, why marks were lost, how to improve, topic; plus strengths / weaknesses / next steps).
   The teacher's marks are FIXED — feedback is written to explain them, never to change them.
5. `node finalize.js <workdir>` = dry run. It refuses feedback that contradicts a mark (e.g. "incorrect" on full marks).
6. `node finalize.js <workdir> --write` writes the report + analysis. The paper STAYS inside Teacher Marking (it never becomes an Exam):
   each student's status becomes "Analysed · ready to publish"; the teacher opens Feedback (editable), then Publish.
   Nothing is ever written to `studentAssessments` here — students only see it after Publish.


## Teacher text notes
Teachers can type notes on the page. `manifest.json` has `students[].notes` ([{page, teacher, text}]). Read them while writing feedback and treat them as the teacher's own comments; the existing grading viewer only shows pen strokes, so notes are NOT drawn there.


## failureMode (required when marks are lost)
Each lost-mark question needs `failureMode`: NEVER_KNEW (no idea / blank), KNEW_BUT_FORGOT, KNEW_BUT_MISAPPLIED (wrong law/term/concept), KNEW_BUT_MISCALCULATED (sign/arithmetic), KNEW_BUT_INCOMPLETE (right idea, parts or numbers missing). The student app uses it for the study plan; without it every gap reads 'zero foundation'. Optional: failurePoint, prerequisiteConcept.

## Analysis rules (enforced by finalize.js)
- Teachers' marks are fixed. Full marks and uncounted OR alternatives get NO feedback.
- Every counted question that lost marks needs: page, studentWrote, missedFromKey (quotes that finalize checks against the answer key / rubric / checking instructions), whyWrong, howToImprove, failureMode. Feedback quoting x/y marks must match the teacher's marks; partial marks cannot be called wholly wrong; zero marks cannot be praised.
- Every question needs topic + concept (chapter-level). Concept mastery, strengths and weaknesses are COMPUTED from the marks (uncounted alternatives excluded). nextSteps may only name weak topics and every big weakness needs one.
- PAPER CHECK: an "Alternative Question (OR) with Question X" must be reciprocated by X, otherwise finalize refuses.
- Read the actual answer-sheet pages (not only OCR text) for every lost-mark question; a second reviewer then checks review-packet.md against key + marks.
- Marks Given = verification: all roster teachers are recorded as verified so teacher/admin Publish works straight away; teachers can edit the analysis (autosaved) first.

- Teachers can add an optional reason on any question in the marking desk (✎). It is exported as `students[].teacherNotes` and shown to the student verbatim as "Teacher's note: …". Your whyWrong must agree with it. The declared paper total is always the total: never compare it with the sum of question marks.

- An OR alternative the student did NOT choose (`altNotChosen:true` in the feedback JSON) is never a weakness, lost mark or mastery item, even when both alternatives scored 0 (tie): it is left out like any other uncounted alternative.
