# Running the Teacher Marking analysis (done by Claude, from chat)

1. Teachers mark on screen → each clicks **Marks Given** → the paper shows **Ready for analysis**.
2. Tell Claude: "Analyse Class 9 A Science — Unit Test 1 for <school>."
3. Claude runs `node export.js "<School>" <class> <section> <subject>` (read-only): exports each READY student's
   teacher marks + page images into `work/…/`. Students not ready are listed and skipped.
4. Claude reads the handwriting and the teachers' marks and writes `work/…/feedback/<roll>.json`
   (one feedback per question, why marks were lost, how to improve, topic; plus strengths / weaknesses / next steps).
   The teacher's marks are FIXED — feedback is written to explain them, never to change them.
5. `node finalize.js <workdir>` = dry run. It refuses feedback that contradicts a mark (e.g. "incorrect" on full marks).
6. `node finalize.js <workdir> --write --complete` writes the standard submission + report documents and turns the
   paper into a normal exam. Teachers then verify in the usual report screen; admin/teacher publish as usual.
   Nothing is ever written to `studentAssessments` here — students only see it after the normal publish.


## Teacher text notes
Teachers can type notes on the page. `manifest.json` has `students[].notes` ([{page, teacher, text}]). Read them while writing feedback and treat them as the teacher's own comments; the existing grading viewer only shows pen strokes, so notes are NOT drawn there.


## failureMode (required when marks are lost)
Each lost-mark question needs `failureMode`: NEVER_KNEW (no idea / blank), KNEW_BUT_FORGOT, KNEW_BUT_MISAPPLIED (wrong law/term/concept), KNEW_BUT_MISCALCULATED (sign/arithmetic), KNEW_BUT_INCOMPLETE (right idea, parts or numbers missing). The student app uses it for the study plan; without it every gap reads 'zero foundation'. Optional: failurePoint, prerequisiteConcept.
