'use strict';
/**
 * Backfill the `gradingEvents` collection from history.
 *
 *   node scripts/backfill-grading-events.js                 # DRY RUN (default) — reads only, prints a summary
 *   node scripts/backfill-grading-events.js --write         # actually writes the events
 *   node scripts/backfill-grading-events.js --before=2026-10-08T00:00:00Z   # only papers uploaded before this moment
 *   node scripts/backfill-grading-events.js --out=events.json               # also dump the events to a file (dry-run safe)
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (service-account key) + GCLOUD_PROJECT=student-database-74297.
 *
 * Safe to re-run: every event gets a deterministic id (bf_… / bfq_…), so running it again
 * overwrites the same documents instead of adding duplicates. Reads use field projection
 * (`select`), so it never downloads the heavy 36 KB report bodies.
 *
 * Use --before with the moment the live trackers (trackGradingEvents etc.) were deployed, so a
 * paper is never counted once by the tracker and again by the backfill.
 */
const admin = require('firebase-admin');
const fs = require('fs');
const { _internals: S } = require('../gradingStats');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
}));
const WRITE = !!args.write;
const CUTOFF = args.before ? Date.parse(args.before) : null;
if (args.before && isNaN(CUTOFF)) { console.error('Bad --before date'); process.exit(1); }

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'student-database-74297' });
const db = admin.firestore();
const TS = admin.firestore.Timestamp;

const SUB_PATH = /^teachers\/([^/]+)\/assessmentHistory\/([^/]+)\/submissions\/([^/]+)$/;
const ASM_PATH = /^teachers\/([^/]+)\/assessmentHistory\/([^/]+)$/;

(async () => {
    const t0 = Date.now();
    console.log(WRITE ? '*** WRITE MODE ***' : 'DRY RUN (no writes) — add --write to apply');

    // 1. teachers → school
    const teachers = new Map();
    (await db.collection('teachers').select('name', 'schoolId', 'schoolName').get()).forEach(d => {
        const t = d.data(); teachers.set(d.id, { name: t.name || '', schoolId: t.schoolId || '', schoolName: t.schoolName || '' });
    });
    console.log('teachers:', teachers.size);

    // 2. assessments → title/class/section/subject
    const assessments = new Map();
    (await db.collectionGroup('assessmentHistory').select('assessmentTitle', 'className', 'section', 'stream', 'subject').get()).forEach(d => {
        const m = d.ref.path.match(ASM_PATH); if (m) assessments.set(`${m[1]}/${m[2]}`, d.data());
    });
    console.log('assessments:', assessments.size);

    // 3. graded papers (one event per submission, dated by when the sheets were uploaded)
    const events = [];
    let skippedPath = 0, undated = 0, afterCutoff = 0, datedByCreateTime = 0;
    const subSnap = await db.collectionGroup('submissions').select('answerSheetImageUrls', 'studentName', 'rollNumber', 'subject', 'gradingTimestamp').get();
    console.log('submission docs scanned:', subSnap.size);
    subSnap.forEach(d => {
        const m = d.ref.path.match(SUB_PATH);
        if (!m) { skippedPath++; return; }
        const [, teacherUid, assessmentId, studentUid] = m;
        const sub = d.data();
        // Date = when the sheets were uploaded (epoch in the filename). Older papers
        // (stored as assessmentSubmissions/…/page_N.jpg) have no epoch, so fall back to
        // the Firestore document's own creation time — always present.
        let ms = S.earliestEpoch(sub.answerSheetImageUrls);
        if (!ms && sub.gradingTimestamp && typeof sub.gradingTimestamp.toMillis === 'function') ms = sub.gradingTimestamp.toMillis();
        if (!ms && d.createTime) { ms = d.createTime.toMillis(); datedByCreateTime++; }
        if (!ms) { undated++; return; }
        if (CUTOFF && ms >= CUTOFF) { afterCutoff++; return; }
        const ev = S.buildGradedEvent({
            teacherUid, teacher: teachers.get(teacherUid), assessmentId, assessment: assessments.get(`${teacherUid}/${assessmentId}`),
            studentUid, sub, timestamp: TS.fromMillis(ms), isRegrade: null, backfilled: true,
        });
        if (ev.pages > 0) events.push({ id: `bf_${teacherUid}_${assessmentId}_${studentUid}`, data: ev });
    });

    // 4. failed attempts that are still sitting in the grading queues
    let failed = 0;
    for (const coll of ['gradingQueue', 'gradingQueueHindiProd']) {
        const snap = await db.collection(coll).where('status', '==', 'ERROR').get();
        snap.forEach(d => {
            const q = d.data();
            const created = q.createdAt && q.createdAt.toMillis ? q.createdAt.toMillis() : (q.finishedAt && q.finishedAt.toMillis ? q.finishedAt.toMillis() : null);
            if (!created) return;
            if (CUTOFF && created >= CUTOFF) return;
            const ev = S.buildFailedEvent({ teacherUid: q.teacherUid || '', teacher: teachers.get(q.teacherUid), queueDoc: q, jobId: d.id, timestamp: TS.fromMillis(created), backfilled: true });
            events.push({ id: `bfq_${coll}_${d.id}`, data: ev }); failed++;
        });
    }

    // 5. summary
    const graded = events.filter(e => e.data.kind === 'graded');
    const sum = (arr, f) => arr.reduce((s, e) => s + f(e), 0);
    console.log(`\nEVENTS: ${events.length}  (graded ${graded.length}, failed ${failed})`);
    console.log(`pages in graded events: ${sum(graded, e => e.data.pages)} | failed-attempt pages: ${sum(events.filter(e => e.data.kind === 'failed'), e => e.data.pages)}`);
    console.log(`skipped: non-teacher path ${skippedPath} | undated ${undated} | after cutoff ${afterCutoff} | dated via createTime fallback ${datedByCreateTime}`);
    const noSchool = graded.filter(e => !e.data.schoolId && !e.data.schoolName).length;
    console.log(`graded events with no school attribution: ${noSchool}`);
    const byMonth = {}; graded.forEach(e => { const m = new Date(e.data.timestamp.toMillis()).toISOString().slice(0, 7); byMonth[m] = byMonth[m] || { papers: 0, pages: 0 }; byMonth[m].papers++; byMonth[m].pages += e.data.pages; });
    console.log('by upload month:', JSON.stringify(Object.fromEntries(Object.entries(byMonth).sort())));
    const bySchool = {}; graded.forEach(e => { const k = e.data.schoolName || '(none)'; bySchool[k] = bySchool[k] || { papers: 0, pages: 0 }; bySchool[k].papers++; bySchool[k].pages += e.data.pages; });
    console.log('top schools:', Object.entries(bySchool).sort((a, b) => b[1].pages - a[1].pages).slice(0, 8).map(([k, v]) => `${k}: ${v.papers}p/${v.pages}pg`).join(' | '));

    if (args.out) {
        fs.writeFileSync(args.out, JSON.stringify(events.map(e => ({ id: e.id, ...e.data, timestamp: e.data.timestamp.toMillis() }))));
        console.log('events dumped to', args.out);
    }

    // 6. write
    if (WRITE) {
        const col = db.collection(S.EVENTS_COLLECTION);
        let n = 0;
        for (let i = 0; i < events.length; i += 400) {
            const batch = db.batch();
            events.slice(i, i + 400).forEach(e => batch.set(col.doc(e.id), e.data));
            await batch.commit(); n += Math.min(400, events.length - i);
            process.stdout.write(`\rwritten ${n}/${events.length}`);
        }
        console.log('\nDone.');
    }
    console.log(`(${Math.round((Date.now() - t0) / 1000)}s)`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
