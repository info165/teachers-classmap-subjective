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

- Teachers can write a PRIVATE reason for cutting marks on any question ("Why marks were cut" in the marking desk, also by voice). The student NEVER sees it. It is exported as `students[].teacherNotes` and is the FIRST and most important input to that question's whyWrong: write whyWrong in the student's own voice ("you wrote…, so marks were lost because…", never "the teacher cut marks because"), then add anything from the rubric / model answer. finalize.js refuses a lost-mark question that has a teacher reason unless the feedback JSON sets `usedTeacherReason:true`. Teacher pen marks are exported too: `pages/<roll>_p<N>_marked.jpg` is the page with every teacher's pen / tick / cross / note drawn on it, and `students[].pages[].annotations` lists each mark with its kind and area; read the marked page, work out what the teacher underlined/crossed, and let it shape whyWrong in the same student voice (the marks themselves are never changed). Your whyWrong must agree with it. The declared paper total is always the total: never compare it with the sum of question marks.

- An OR alternative the student did NOT choose (`altNotChosen:true` in the feedback JSON) is never a weakness, lost mark or mastery item, even when both alternatives scored 0 (tie): it is left out like any other uncounted alternative.

## Student-language rules (enforced) + cost model — 2026-11-05
- **Never reference the key/rubric/marking scheme to a student.** finalize.js rejects any student-facing feedback containing "the key", "key's answer", "key says/gives/…", "rubric", "marking scheme", "answer key". Say the correct fact directly, in the student's own words ("The vacuole has a single membrane; you chose the nucleus."), never "the key's answer is…".
- **MCQ / True-False / Assertion-Reason wrong answers are auto-templated — NO model tokens.** finalize.js writes `The correct answer is <answer>.` straight from the paper. Do not hand-write these.
- **Subjective lost marks: explain fully** (don't artificially cap) but in student voice: what went wrong + how to improve, grounded in the real answer. whyWrong/howToImprove/failureMode required.
- **Summary is mechanical** (built from concept mastery, 100% accurate): "Scored X/Y (Z%). Strong on …. The main areas to work on are …." No AI `insight` field.
- **Dropped scaffolding** (saves ~1/3 of generated tokens, nothing shown to anyone): `studentWrote` and `missedFromKey` are gone. Grounding is now checked by the sampling audit, not by self-quoting.
- **Student learning summary** keeps: summary, concept mastery, what you did well, where to improve, next steps. "Where the marks went (by mistake type)" is removed from the student PDF and the teacher Feedback panel.
- **Sampling audit (for now, Claude/Sonnet; later Gemini):** after generating, build review-packet-<roll>.md and have an independent pass check each lost-mark line against the real answer + marks + sheet image, and flag any over-attribution, wrong fact, or key/rubric wording. Fix before publish.
- **Workflow:** user says "class X Science is done" → run `export.js "<School>" <class> <section> <subject>` to pick up every student all teachers have finished → generate feedback → finalize → audit sample → publish.
