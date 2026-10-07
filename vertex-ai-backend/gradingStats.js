'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GRADING ANALYTICS — gradingEvents collection
//
// Why this exists: the Super Admin "Cost Analytics" dashboard needs to answer
// "how many papers / pages were graded, in which school, and how often did we
// have to re-scan?". That data used to be unreachable:
//   • every graded paper is a ~36 KB document, so the dashboard can't count
//     them by reading them (14.8k papers ≈ 540 MB), and
//   • their `gradingTimestamp` was saved as an empty object `{}` (the grader's
//     `cleanUndefined()` flattens the server-timestamp placeholder), so no
//     date filter could ever match them.
//
// Fix: one tiny, purpose-built document per grading event.
//
//   gradingEvents/{id}
//     kind:        'graded' | 'failed'
//     timestamp:   Timestamp   (when it happened — live: server time;
//                               backfill: when the answer sheets were uploaded)
//     teacherUid, teacherName, schoolId, schoolName
//     assessmentId, assessmentTitle, className, section, stream, subject
//     studentUid, studentName, rollNumber
//     pages:       number of answer-sheet pages in this attempt
//     isRegrade:   true  → this paper had ALREADY been graded before (a re-scan)
//                  false → first time graded
//                  null  → unknown (backfilled history)
//     backfilled:  true for rows rebuilt from history by the backfill script
//     (failed only) jobId, error
//
// Two Firestore triggers keep it up to date. They are completely separate
// from the grading pipeline — they only OBSERVE writes the grader already makes,
// so they cannot slow down, break, or change grading in any way.
// ─────────────────────────────────────────────────────────────────────────────

const { onDocumentWritten, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

const EVENTS_COLLECTION = 'gradingEvents';

// Answer-sheet files are stored as "<epoch-ms>_<name>.pdf_page_N.jpg"; the epoch
// is the moment the sheets were uploaded. Used to date historical papers.
function epochFromUrl(u) {
    try {
        let p = String(u || '');
        p = p.split('/o/')[1] || p;
        p = decodeURIComponent(p.split('?')[0].split('#')[0]);
        const m = p.split('/').pop().match(/^(\d{12,13})_/);
        return m ? Number(m[1]) : null;
    } catch (_) { return null; }
}

function earliestEpoch(urls) {
    const all = (Array.isArray(urls) ? urls : []).map(epochFromUrl).filter(Boolean);
    return all.length ? Math.min(...all) : null;
}

function pageCount(urls) {
    return Array.isArray(urls) ? urls.length : 0;
}

// Teacher → { name, schoolId, schoolName }, cached for the life of the instance.
const _teacherCache = new Map();
async function resolveTeacher(db, teacherUid) {
    if (_teacherCache.has(teacherUid)) return _teacherCache.get(teacherUid);
    let info = { name: '', schoolId: '', schoolName: '' };
    try {
        const snap = await db.collection('teachers').doc(teacherUid).get();
        if (snap.exists) {
            const t = snap.data() || {};
            info = { name: t.name || '', schoolId: t.schoolId || '', schoolName: t.schoolName || '' };
        }
    } catch (_) { /* leave blank — analytics must never throw */ }
    _teacherCache.set(teacherUid, info);
    return info;
}

function buildGradedEvent({ teacherUid, teacher, assessmentId, assessment, studentUid, sub, timestamp, isRegrade, backfilled }) {
    const a = assessment || {};
    const t = teacher || {};
    return {
        kind: 'graded',
        timestamp,
        teacherUid,
        teacherName: t.name || '',
        schoolId: t.schoolId || '',
        schoolName: t.schoolName || '',
        assessmentId,
        assessmentTitle: a.assessmentTitle || '',
        className: a.className || '',
        section: a.section || '',
        stream: a.stream || '',
        subject: a.subject || (sub && sub.subject) || '',
        studentUid,
        studentName: (sub && sub.studentName) || '',
        rollNumber: (sub && sub.rollNumber) || '',
        pages: pageCount(sub && sub.answerSheetImageUrls),
        isRegrade: isRegrade === undefined ? null : isRegrade,
        source: 'exam',
        backfilled: !!backfilled,
    };
}

function buildFailedEvent({ teacherUid, teacher, queueDoc, jobId, timestamp, backfilled }) {
    const q = queueDoc || {};
    const t = teacher || {};
    const urls = q.answerSheetImageUrls || q.filePaths || [];
    return {
        kind: 'failed',
        timestamp,
        teacherUid,
        teacherName: t.name || '',
        schoolId: t.schoolId || '',
        schoolName: t.schoolName || '',
        assessmentId: q.assessmentId || '',
        subject: q.subject || '',
        studentUid: q.studentUid || '',
        studentName: q.studentName || '',
        rollNumber: q.rollNumber || '',
        pages: pageCount(urls),
        isRegrade: null,
        source: q.isHomework ? 'homework' : 'exam',
        jobId: jobId || '',
        error: String(q.error || q.statusDetails || '').slice(0, 200),
        backfilled: !!backfilled,
    };
}

// The part of a submission that only the GRADER rewrites. A teacher editing marks,
// publishing, or the auditor correcting a report touches other fields, so those
// writes leave this signature unchanged and are (correctly) not counted as gradings.
function gradingSignature(d) {
    const gt = d && d.gradingTimestamp;
    return JSON.stringify([
        d && d.answerSheetImageUrls || [],
        d && d.studentIntelligence || null,
        d && d.studentKeywords || [],
        gt && typeof gt.seconds === 'number' ? gt.seconds : null,
    ]);
}

// ── Trigger 1: a paper was graded (or re-graded) ────────────────────────────
exports.trackGradingEvents = onDocumentWritten(
    {
        document: 'teachers/{teacherUid}/assessmentHistory/{assessmentId}/submissions/{studentUid}',
        region: 'us-central1',
        memory: '256MiB',
        timeoutSeconds: 60,
    },
    async (event) => {
        try {
            const change = event.data;
            if (!change || !change.after || !change.after.exists) return;       // deletion
            const after = change.after.data() || {};
            const before = change.before && change.before.exists ? change.before.data() : null;

            let isRegrade = false;
            if (before) {
                if (gradingSignature(after) === gradingSignature(before)) return; // an edit, not a grading
                isRegrade = true;
            }

            const db = admin.firestore();
            const { teacherUid, assessmentId, studentUid } = event.params;
            const [teacher, aSnap] = await Promise.all([
                resolveTeacher(db, teacherUid),
                db.collection('teachers').doc(teacherUid).collection('assessmentHistory').doc(assessmentId).get(),
            ]);
            const ev = buildGradedEvent({
                teacherUid, teacher, assessmentId,
                assessment: aSnap.exists ? aSnap.data() : null,
                studentUid, sub: after,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                isRegrade, backfilled: false,
            });
            await db.collection(EVENTS_COLLECTION).add(ev);
        } catch (err) {
            console.warn('[trackGradingEvents] non-critical failure:', err && err.message);
        }
    }
);

// ── Trigger 2/3: a grading job failed ───────────────────────────────────────
function makeFailureTracker(queueCollection, exportName) {
    return onDocumentUpdated(
        {
            document: `${queueCollection}/{jobId}`,
            region: 'us-central1',
            memory: '256MiB',
            timeoutSeconds: 60,
        },
        async (event) => {
            try {
                const change = event.data;
                if (!change) return;
                const before = change.before.data() || {};
                const after = change.after.data() || {};
                if (after.status !== 'ERROR' || before.status === 'ERROR') return;
                const db = admin.firestore();
                const teacher = after.teacherUid ? await resolveTeacher(db, after.teacherUid) : null;
                const ev = buildFailedEvent({
                    teacherUid: after.teacherUid || '',
                    teacher, queueDoc: after, jobId: event.params.jobId,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    backfilled: false,
                });
                await db.collection(EVENTS_COLLECTION).add(ev);
            } catch (err) {
                console.warn(`[${exportName}] non-critical failure:`, err && err.message);
            }
        }
    );
}
exports.trackGradingFailures = makeFailureTracker('gradingQueue', 'trackGradingFailures');
exports.trackGradingFailuresHindiProd = makeFailureTracker('gradingQueueHindiProd', 'trackGradingFailuresHindiProd');

// Exposed for the backfill script and tests.
exports._internals = {
    EVENTS_COLLECTION, epochFromUrl, earliestEpoch, pageCount,
    buildGradedEvent, buildFailedEvent, gradingSignature,
};
