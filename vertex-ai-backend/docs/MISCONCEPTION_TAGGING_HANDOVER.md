# Handover: misconception tags for the ClassMap merged question bank

## Goal
Tag every wrong option of every published MCQ in the merged bank with one plain-language
misconception, so a teacher's "Common mistakes" card can say "23% picked 'dissolving = reacting'".

## Facts (verified 2026-10-03)
- Merged bank: 78,765 published questions, 2,490 topic sources, classes 6–10, four subjects.
  Index: `mergedIndex/class_N__subject`. Hindi is held out.
- Sample of 2,093 published questions (63 topics): **0** have `misconceptionTag`,
  `distractorProfile`, `wrongOptionNotes`, or `misconceptionRationale`.
- Every question has `options`, `answer` (letter or text), and `explanation` (prose that already
  says why each wrong option is wrong, e.g. "Option B is incorrect: evaporation isn't related…").
- MCQ-type questions are about half the bank. CBQ parts are MCQ or short-answer.

## Where tags go
Add one field per question: `wrongOptionTags`, an object keyed by option letter:
```json
"wrongOptionTags": {
  "B": { "tag": "Evaporation causes lather", "rationale": "Lather and scum come from soap reacting with hard-water ions, not from evaporation." },
  "C": { "tag": "Detergent reacts with soap", "rationale": "No detergent is present in test tube A." }
}
```
- `tag`: 3–6 words a teacher reads aloud. No jargon. Written as the student's wrong idea.
- `rationale`: one sentence, must be supported by the explanation or the syllabus text.
- Keys are the bank letters (A–D as stored), not the shuffled letters a student sees.
- Only wrong options get tags. The correct option gets none.
- Read by the apps as `wrongOptionTags`. Existing reader code currently looks for
  `misconceptionTag`; change it when this lands.

## Rules (non-negotiable)
1. **Source only.** A tag must be justified by the question's own explanation, or by the
   NCERT / board syllabus text for that chapter. Do not invent misconceptions.
2. **No new facts.** Do not change `text`, `options`, `answer`, or `explanation`.
3. **If unsure, leave it out.** A missing tag is better than a wrong one. Record the question
   id in a `needs_human` list.
4. **Simple.** A class 6 teacher must understand the tag at a glance.
5. **Same wording for the same idea** across questions, so counts add up.

## Pilot before any write (required)
1. Pick one chapter per class/subject (e.g. Class 10 Science `carbon_and_its_compounds`,
   topic `board_4_7`; it has 20 published questions across both banks).
2. Generate tags for the pilot only. Write nothing to Firestore yet.
3. Human reviews every tag against the explanation and the syllabus. Track: accepted /
   reworded / rejected.
4. Go to the batch only if at least 95% are accepted with no rewording of the meaning.
   Below that, fix the prompt and pilot again.

## Batch (after pilot passes)
- Run per `mergedIndex` source path. Use `set({ wrongOptionTags }, { merge: true })` on each
  question doc. Never touch other fields.
- Write a per-topic log: question ids tagged, ids in `needs_human`, model and prompt version.
- Re-run the coverage check: every published MCQ is tagged or listed in `needs_human`.
- Sample 50 random tagged questions per subject for a second human review before publish.

## Who signs off
- A subject reviewer approves the pilot and the 50-question sample.
- The question bank owner approves the batch write. This changes the bank, so it needs explicit
  approval.

## Cost estimate, not yet run
- About 39,000 MCQs × ~1 call each. Measure the cost on the pilot before approving the batch.

## Start here in the new chat
1. Read this file and `scratchpad/misc_sample.cjs` (the sample check).
2. Run the pilot on `carbon_and_its_compounds` / `board_4_7`.
3. Send the pilot tags for review. Stop there and wait for approval.
