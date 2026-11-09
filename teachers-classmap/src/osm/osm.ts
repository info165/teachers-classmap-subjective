import { computeLearn, learnBlocks } from './learn';
import { renderClassAnalysis } from './classAnalysis';
/**
 * Teacher Marking ("OSM") — teachers enter marks per question on the screen.
 *
 * DESIGN RULES (see osm-test-school/OSM-PROGRESS.md):
 *  - Self-contained: nothing here touches the existing exam / grading / report code paths.
 *  - Data lives where same-school teachers ALREADY have read+write under the live Firestore rules:
 *      teachers/{owner}/assessmentHistory/{paperId}                       (paper, assessmentMode:'osm')
 *      .../submissions/{studentUid}/detail/osm                            (pages, marks, done flags)
 *      .../submissions/{studentUid}/detail/osmInk_{teacherUid}            (pen strokes, one doc per teacher)
 *      .../submissions/_meta/detail/osm                                   (assignments, readiness)
 *    `submissions/{id}` parent docs are NEVER created, so existing code that lists `submissions`
 *    does not see OSM students at all.
 *  - Parallel teachers: every mark is saved as a merge-write of ONE field (marks.q<i>), so three
 *    teachers saving at the same moment never overwrite each other.
 *  - Total marks = the paper's declared totalMarks. Never summed from questions. OR-alternatives:
 *    the existing computeOrLoserQNums rule (via bridge) decides which side is not counted.
 */

export interface OsmBridge {
    db: any;                       // firebase.firestore.Firestore
    storage: any;                  // firebase.storage.Storage
    FieldValue: any;               // firebase.firestore.FieldValue
    teacher: () => { uid: string; name: string; schoolName: string; board?: string } | null;
    toast: (msg: string, type?: 'error' | 'success' | 'info') => void;
    loading: (show: boolean, text?: string) => void;
    parseExcel: (file: File) => Promise<any[]>;
    pdfToImages: (file: File) => Promise<File[]>;
    processImage: (file: File) => Promise<File>;
    fmtMath: (text: string) => string;
    typeset: (el: HTMLElement) => Promise<void> | void;
    orLosers: (reports: any[], questions: any[]) => Set<string>;
    backToClass: () => void;
    analysisPdf: (report: any, ctx: any, onProgress?: (t: string) => void) => Promise<void>;
}

let B: OsmBridge;
// The host app's toast + loading overlay sit UNDER this full-screen UI, so Teacher Marking shows its own (always on top).
function toast(msg: string, type: 'error' | 'success' | 'info' = 'info') {
    let host = document.getElementById('osm-toasts');
    if (!host) { host = document.createElement('div'); host.id = 'osm-toasts'; document.body.appendChild(host); }
    const t = document.createElement('div'); t.className = 'osm-toast ' + type; t.textContent = msg; host.appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 8000 : 4500);
}
function busy(show: boolean, text = 'Working…') {
    let o = document.getElementById('osm-busy');
    if (!show) { o?.remove(); return; }
    if (!o) { o = document.createElement('div'); o.id = 'osm-busy'; o.innerHTML = '<div class="osm-spin"></div><div class="osm-busy-t"></div>'; document.body.appendChild(o); }
    (o.querySelector('.osm-busy-t') as HTMLElement).textContent = text;
}
// Sheet uploads run in the background, one job per student, so a teacher can start the next student straight away.
type UpJob = { stu: any; files: File[]; mode: 'add' | 'replace'; state: 'run' | 'ok' | 'err'; done: number; total: number; msg: string };
const upJobs = new Map<string, UpJob>();
// How the student list is ordered. Remembered on this device; default is alphabetical by student name so every teacher sees the same order.
type SortKey = 'roll' | 'name' | 'sheet' | 'marks' | 'status';
let sortKey: SortKey = 'name', sortDir: 1 | -1 = 1;
try { const v = JSON.parse(localStorage.getItem('osm-sort-v1') || 'null'); if (v && ['roll', 'name', 'sheet', 'marks', 'status'].includes(v.k)) { sortKey = v.k; sortDir = v.d === -1 ? -1 : 1; } } catch { /* ignore */ }
const STATUS_RANK: Record<string, number> = { nosheet: 0, new: 1, prog: 2, ready: 3, analysed: 4, published: 5 };
let upPaint: ((uid: string) => void) | null = null;
if (typeof window !== 'undefined') window.addEventListener('beforeunload', e => { if ([...upJobs.values()].some(j => j.state === 'run')) { e.preventDefault(); e.returnValue = ''; } });
export function initOsm(bridge: OsmBridge) { B = bridge; injectStyle(); }

// ───────────────────────── types ─────────────────────────
interface Paper {
    owner: string; id: string; title: string; className: string; section: string; subject: string; stream: string;
    totalMarks: number; questions: any[]; created: string; schoolName: string; previewCopyOf?: any;
}
interface Roster { id: string; className: string; section: string; subject: string; stream?: string; schoolName: string; students: any[]; board?: string; teacherUid: string }
interface StuDoc { notes?: Record<string, { t: string; by: string; n: string; at: number }>; pagesVersion?: number; studentUid: string; studentName: string; rollNumber: string; pages?: { url: string; path: string }[]; marks?: Record<string, { v: number; by: string; n: string; t: number }>; done?: Record<string, { n: string; t: number }>; }
interface Meta { assign?: Record<string, number[]>; students?: Record<string, string[]>; readyForAnalysis?: boolean; }

const _svg = (d: string) => `<svg class="osm-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON: Record<string, string> = {
    edit: _svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    send: _svg('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'),
    file: _svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
    upload: _svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>'),
    check: _svg('<path d="M20 6 9 17l-5-5"/>'),
    plus: _svg('<path d="M12 5v14M5 12h14"/>'),
    eyeoff: _svg('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22"/>'),
    pen: _svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    msg: _svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'),
    back: _svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
    next: _svg('<path d="M5 12h14M12 5l7 7-7 7"/>'),
    user: _svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
};
const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const qk = (i: number) => `q${i}`;
const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const qMax = (q: any) => Number(q?.marks) || 0;
const shortName = (name: string, all: { name: string }[]) => { const w = name.split(' '); for (let k = 1; k <= w.length; k++) { const c = w.slice(0, k).join(' '); if (all.filter(a => a.name.startsWith(c + ' ') || a.name === c).length === 1) return c; } return name; };
const fmt1 = (n: number) => (Math.round(n * 100) / 100).toString();
// one distinct colour per mark value (0, 0.5, 1 … ) so a glance at the panel shows what was given
const PALETTE = ['#e53935', '#fb8c00', '#43a047', '#00acc1', '#1e88e5', '#8e24aa', '#d81b60', '#6d4c41', '#00897b', '#7cb342', '#3949ab', '#f4511e', '#039be5', '#5e35b1', '#afb42b', '#546e7a', '#ec407a', '#26a69a', '#ffa000', '#5c6bc0', '#8d6e63'];
const markColor = (v: number) => PALETTE[Math.round(v * 2) % PALETTE.length];
// exactly three colours per question: green = full marks, yellow = in between, red = zero; not attempted = grey and blank
const chipColor = (v: number, max: number) => max > 0 && v >= max ? '#2e9e4f' : v <= 0 ? '#e53935' : '#f2a900';
const qColor = (m: any, max: number) => !m || m.na ? '#b8c0d0' : chipColor(Number(m.v) || 0, max);

// ───────────────────────── firestore paths ─────────────────────────
const paperRef = (owner: string, id: string) => B.db.collection('teachers').doc(owner).collection('assessmentHistory').doc(id);
const stuRef = (p: Paper, uid: string) => paperRef(p.owner, p.id).collection('submissions').doc(uid).collection('detail').doc('osm');
const inkRef = (p: Paper, uid: string, teacherUid: string) => paperRef(p.owner, p.id).collection('submissions').doc(uid).collection('detail').doc('osmInk_' + teacherUid);
const metaRef = (p: Paper) => paperRef(p.owner, p.id).collection('submissions').doc('_meta').collection('detail').doc('osm');

// ───────────────────────── root / navigation ─────────────────────────
let root: HTMLElement | null = null;
let stopListeners: Array<() => void> = [];
function ensureRoot(): HTMLElement {
    if (!root) {
        root = document.createElement('div');
        root.id = 'osm-root';
        document.body.appendChild(root);
    }
    root.style.display = 'block';
    document.body.classList.add('osm-active');
    return root;
}
export function closeOsm() {
    stopListeners.forEach(f => { try { f(); } catch { /* ignore */ } });
    stopListeners = [];
    if (root) root.style.display = 'none';
    document.body.classList.remove('osm-active');
}
function clearListeners() { stopListeners.forEach(f => { try { f(); } catch { /* ignore */ } }); stopListeners = []; }

// ───────────────────────── loading papers / teachers ─────────────────────────
async function expectedTeachers(r: Roster): Promise<{ uid: string; name: string; email?: string }[]> {
    const snap = await B.db.collection('classRosters')
        .where('className', '==', r.className).where('section', '==', r.section)
        .where('subject', '==', r.subject).where('schoolName', '==', r.schoolName).get();
    const out: { uid: string; name: string; email?: string }[] = [];
    snap.docs.forEach((d: any) => {
        const x = d.data();
        if ((x.stream || '') !== (r.stream || '')) return;
        if (!out.some(o => o.uid === x.teacherUid)) out.push({ uid: x.teacherUid, name: x.teacherName || x.teacherUid, email: x.teacherEmail || '' });
    });
    return out;
}

async function loadPapers(r: Roster, teachers: { uid: string; name: string }[], skipOwners: Set<string> = new Set()): Promise<Paper[]> {
    const all: Paper[] = [];
    const me = B.teacher()!.uid;
    const uids = teachers.map(t => t.uid).filter(u => !skipOwners.has(u) || u === me);
    if (!uids.includes(me)) uids.push(me);
    await Promise.all(uids.map(async uid => {
        try {
            const snap = await B.db.collection('teachers').doc(uid).collection('assessmentHistory').where('assessmentMode', '==', 'osm').get();
            snap.docs.forEach((d: any) => {
                const x = d.data();
                if (String(x.className) !== String(r.className) || x.section !== r.section || x.subject !== r.subject) return;
                if ((x.stream || '') !== (r.stream || '')) return;
                all.push({
                    owner: uid, id: d.id, previewCopyOf: x.previewCopyOf, title: x.assessmentTitle || 'Untitled', className: x.className, section: x.section,
                    subject: x.subject, stream: x.stream || '', totalMarks: Number(x.totalMarks) || 0, questions: x.questions || [],
                    created: x.creationTimestamp || '', schoolName: x.schoolName || r.schoolName,
                });
            });
        } catch (e) { console.warn('[osm] could not read papers of', uid, e); }
    }));
    // Same title (case/space-insensitive) = same paper. Earliest-created copy is the canonical owner.
    const byTitle = new Map<string, Paper>();
    all.sort((a, b) => (a.created || '').localeCompare(b.created || '') || a.owner.localeCompare(b.owner));
    all.forEach(p => { const k = norm(p.title); if (!byTitle.has(k)) byTitle.set(k, p); });
    return [...byTitle.values()].sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}

// ───────────────────────── scoring (declared total; OR rule reused) ─────────────────────────
function scoreFor(paper: Paper, marks: StuDoc['marks'] | undefined) {
    const reports = paper.questions.map((q, i) => ({
        questionNumber: q.questionNumber || String(i + 1),
        marksAwarded: marks?.[qk(i)]?.v ?? 0,
        maxMarksForQuestion: qMax(q),
        checkingInstructions: q.checkingInstructions || '',
    }));
    let losers: Set<string>;
    try { losers = B.orLosers(reports, paper.questions); } catch { losers = new Set(); }
    let total = 0;
    reports.forEach(r => { if (!losers.has(r.questionNumber)) total += r.marksAwarded || 0; });
    const marked = paper.questions.filter((_, i) => marks?.[qk(i)] !== undefined).length;
    return { total, losers, marked, count: paper.questions.length };
}
const declaredTotal = (p: Paper) => p.totalMarks > 0 ? p.totalMarks : 0;

function studentState(paper: Paper, s: StuDoc | undefined, meta: Meta, teachers: { uid: string; name: string }[], parent?: any) {
    if (!s || !s.pages?.length) return { code: 'nosheet', label: 'No sheet', ready: false, doneBy: [] as string[], needBy: [] as string[] };
    const sc = scoreFor(paper, s.marks);
    const contributors = new Set<string>(Object.values(s.marks || {}).map(m => m.by));
    const assigned = Object.entries(meta.assign || {}).filter(([, a]) => a?.length).map(([u]) => u);
    // Who must click Completed for THIS student: every teacher who chose questions (they all mark every student, each their own questions),
    // unless that teacher chose "My students" and this student is not one of them; plus anyone who actually entered a mark for this student.
    const stuUid = s.studentUid;
    const assignedHere = assigned.filter(u => { const f = (meta.students || {})[u]; return !f || !f.length || f.includes(stuUid); });
    const need = [...new Set([...assignedHere, ...contributors])];
    const doneBy = Object.keys(s.done || {});
    // step 2 + 3 of the flow: once Claude has analysed the sheet a report exists (parent doc); publishing sets published:true
    if (parent) { const pub = !!parent.published; return { code: pub ? 'published' : 'analysed', label: pub ? 'Published' : 'Analysed · ready to publish', ready: false, doneBy, needBy: [] as string[] }; }
    const allMarked = sc.marked >= sc.count && sc.count > 0;
    const ready = allMarked && need.length > 0 && need.every(u => doneBy.includes(u));
    const nameOf = (u: string) => teachers.find(t => t.uid === u)?.name || u;
    if (ready) return { code: 'ready', label: 'Ready for analysis', ready, doneBy, needBy: [] };
    if (sc.marked === 0) return { code: 'new', label: 'Not started', ready, doneBy, needBy: need.map(nameOf) };
    return { code: 'prog', label: `In progress · ${sc.marked}/${sc.count}`, ready, doneBy, needBy: need.filter(u => !doneBy.includes(u)).map(nameOf) };
}

// ───────────────────────── Exams box integration ─────────────────────────
// Papers are created with the Teacher Marking card's "+" (the same form as Exams; index.tsx saves them with assessmentMode:'osm').
// They are listed in their own Teacher Marking card on the class page; opening one goes straight to the paper screen.
const PREVIEW_EMAIL = 'marking.preview@classmap.in';
async function visibleContext(roster: Roster) {
    const all = await expectedTeachers(roster);
    const me = B.teacher()!;
    const teachers = all.filter(t => t.email !== PREVIEW_EMAIL || t.uid === me.uid);
    const skip = new Set(all.filter(t => t.email === PREVIEW_EMAIL && t.uid !== me.uid).map(t => t.uid));
    const papers = await loadPapers(roster, all, skip);
    return { all, teachers, papers };
}
export async function osmTitleExists(roster: Roster, title: string): Promise<boolean> {
    const { papers } = await visibleContext(roster);
    return papers.some(p => norm(p.title) === norm(title));
}
export async function renderOsmExamRows(container: HTMLElement, roster: Roster) {
    const { teachers, papers } = await visibleContext(roster);
    container.innerHTML = '';
    if (!papers.length) { container.innerHTML = '<div class="cp-list-empty">No Teacher Marking papers yet. Use + to create one.</div>'; return; }
    const frag = document.createDocumentFragment();
    papers.forEach(p => {
        const div = document.createElement('div');
        div.className = 'cp-list-item osm-row';
        div.style.cursor = 'pointer';
        div.innerHTML = `<div class="cp-list-item-info"><div class="cp-list-item-title">${esc(p.title)}</div>
            <div class="cp-list-item-meta">✍️ On-screen marking &nbsp;·&nbsp; ${declaredTotal(p) || 'N/A'} marks &nbsp;·&nbsp; ${p.questions.length} questions &nbsp;·&nbsp; ${p.created ? new Date(p.created).toLocaleDateString('en-GB') : ''}</div></div>
            <div class="cp-list-item-actions" style="display:flex;"><button class="button-primary small-button">Open</button></div>`;
        div.addEventListener('click', () => openPaper(roster, p, teachers));
        frag.appendChild(div);
    });
    container.prepend(frag);
}

function shell(title: string, sub: string, bodyHtml: string, backLabel = 'Back to class') {
    return `<div class="osm-top">
        <button class="osm-btn ghost" id="osm-close">${ICON.back}<span>${esc(backLabel)}</span></button>
        <div class="osm-titlebox"><div class="osm-title">${esc(title)}</div><div class="osm-sub">${sub}</div></div>
        <div class="osm-top-right"></div></div>
      <div class="osm-body">${bodyHtml}</div>`;
}
function wireClose(el: HTMLElement, fn?: () => void) {
    el.querySelector('#osm-close')?.addEventListener('click', fn || (() => { closeOsm(); B.backToClass(); }));
}

// ───────────────────────── SCREEN B: paper screen (upload + mark, one view) ─────────────────────────
// ───────────────────────── step 3: publishing (same document the Exams "Publish" writes) ─────────────────────────
const subRef = (p: Paper, uid: string) => paperRef(p.owner, p.id).collection('submissions').doc(uid);
const plain = (o: any) => JSON.parse(JSON.stringify(o, (_k, v) => v === undefined ? null : v));
// Student copies of the answer sheets carry every teacher's pen marks, notes, ticks and crosses baked into the picture.
// Originals are never touched: new pictures are uploaded and only the student's published copy points at them.
async function bakedSheetUrls(paper: Paper, uid: string, urls: string[]): Promise<string[]> {
    const me = B.teacher()!;
    const [stuSnap, detail] = await Promise.all([stuRef(paper, uid).get(), paperRef(paper.owner, paper.id).collection('submissions').doc(uid).collection('detail').get()]);
    const pv = stuSnap.exists ? (stuSnap.data().pagesVersion ?? null) : null;
    const inks: Record<string, Record<string, InkStroke[]>> = {};
    detail.docs.forEach((d: any) => { if (d.id.startsWith('osmInk_') && (d.data().pv ?? null) === pv) inks[d.id.slice(7)] = d.data().pages || {}; });
    const out = urls.slice();
    for (let i = 0; i < urls.length; i++) {
        const strokes: InkStroke[] = Object.values(inks).flatMap(pg => (pg[String(i)] || []));
        if (!strokes.length) continue;
        try {
            const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 30000);
            const blob = await (await fetch(urls[i], { mode: 'cors', signal: ctl.signal })).blob(); clearTimeout(to);
            const bmp = await createImageBitmap(blob); const w = Math.min(2200, bmp.width); const h = Math.round(bmp.height * w / bmp.width);
            const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
            g.save(); g.scale(w / 1000, w / 1000); g.lineCap = 'round'; g.lineJoin = 'round';
            strokes.forEach((st: any) => {
                if (st.k) { const x = +st.x || 0, y = +st.y || 0, z = +st.w || 40; g.strokeStyle = st.k === 'tick' ? '#1e8e4e' : '#d93025'; g.lineWidth = z * .15; g.stroke(new Path2D(st.k === 'tick' ? `M${x - .45 * z} ${y + .02 * z} L${x - .12 * z} ${y + .38 * z} L${x + .5 * z} ${y - .4 * z}` : `M${x - .4 * z} ${y - .4 * z} L${x + .4 * z} ${y + .4 * z} M${x + .4 * z} ${y - .4 * z} L${x - .4 * z} ${y + .4 * z}`)); }
                else if (st.t !== undefined) { const fs = +st.w || 24; g.font = `600 ${fs}px Poppins, Arial, sans-serif`; g.fillStyle = st.c || '#d93025'; g.strokeStyle = '#fff'; g.lineWidth = Math.max(3, fs / 6); String(st.t).split('\n').forEach((ln: string, li: number) => { g.strokeText(ln, +st.x || 0, (+st.y || 0) + li * fs * 1.2); g.fillText(ln, +st.x || 0, (+st.y || 0) + li * fs * 1.2); }); }
                else if (st.d) { g.strokeStyle = st.c || '#d93025'; g.lineWidth = +st.w || 3; g.stroke(new Path2D(st.d)); }
            });
            g.restore();
            const jpg: Blob = await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/jpeg', 0.92));
            const path = `gradedReports/${me.uid}/${paper.id}/${uid}/published_p${i + 1}_${Date.now().toString(36)}.jpg`;
            await B.storage.ref(path).put(jpg, { contentType: 'image/jpeg' });
            out[i] = await B.storage.ref(path).getDownloadURL();
        } catch (e: any) { throw new Error(`could not add the teachers' marks to sheet page ${i + 1} (${e?.message || e})`); }
    }
    return out;
}
// Papers copied for previewing never publish to the real students: they go to the one preview student account instead.
async function publishTarget(paper: Paper, uid: string): Promise<string> {
    if (!paper.previewCopyOf) return uid;
    const me = B.teacher()!; const t = await B.db.collection('teachers').doc(me.uid).get(); const pu = t.exists ? t.data().previewStudentUid : '';
    if (!pu) throw new Error('this is a preview paper and no preview student account is set up for it');
    return pu;
}
async function publishOne(paper: Paper, uid: string) {
    await obFlush(); if (obPendingCount()) throw new Error('some of your recent changes are not saved to the cloud yet — wait for “All changes saved” at the top, then publish');
    const ref = subRef(paper, uid);
    const [s, r] = await Promise.all([ref.get(), ref.collection('detail').doc('report').get()]);
    if (!s.exists || !r.exists) throw new Error('This student has not been analysed yet.');
    const forStudent: any = { ...s.data(), questionWiseReport: r.data().questionWiseReport || [], submissionDocId: uid, assessmentId: paper.id, assessmentTitle: paper.title, subject: paper.subject, className: paper.className, section: paper.section, gradingTimestamp: new Date().toISOString() };
    delete forStudent.published;
    if (Array.isArray(forStudent.answerSheetImageUrls) && forStudent.answerSheetImageUrls.length) forStudent.answerSheetImageUrls = await bakedSheetUrls(paper, uid, forStudent.answerSheetImageUrls);
    if (Array.isArray(forStudent.answerSheetImageUrls)) forStudent.publishSheetUrls = forStudent.answerSheetImageUrls;
    const batch = B.db.batch();
    batch.update(ref, { published: true, ...(forStudent.publishSheetUrls ? { publishSheetUrls: forStudent.publishSheetUrls } : {}) });
    const target = await publishTarget(paper, uid);
    if (paper.previewCopyOf) forStudent.assessmentTitle = `${paper.title} — ${s.data().studentName || ''}`.trim();
    batch.set(B.db.collection('studentAssessments').doc(target).collection('assessments').doc(`${paper.id}_${uid}`), plain(forStudent));
    await batch.commit();
}
async function unpublishOne(paper: Paper, uid: string) {
    const batch = B.db.batch();
    batch.update(subRef(paper, uid), { published: false });
    batch.delete(B.db.collection('studentAssessments').doc(await publishTarget(paper, uid)).collection('assessments').doc(`${paper.id}_${uid}`));
    await batch.commit();
}

async function openPaper(roster: Roster, paper: Paper, teachers: { uid: string; name: string }[]) {
    const el = ensureRoot();
    clearListeners();
    el.innerHTML = shell(paper.title, `Class ${esc(paper.className)}–${esc(paper.section)} · ${esc(paper.subject)} · ${declaredTotal(paper) || '—'} marks · ${paper.questions.length} questions`, `<div class="osm-center"><div class="osm-spin"></div></div>`, 'Back to class');
    wireClose(el);
    const me = B.teacher()!;
    let docs = new Map<string, StuDoc>(); let parents = new Map<string, any>();
    let meta: Meta = {}; let readFailed = false; let busyFlag = false; let warnedRead = false;
    async function reload() {
        readFailed = false;
        const [mSnap, ...sSnaps] = await Promise.all([
            metaRef(paper).get(),
            ...roster.students.map((s: any) => stuRef(paper, s.uid).get().catch(() => { readFailed = true; return null; })),
        ]);
        meta = mSnap.exists ? mSnap.data() : {};
        docs = new Map();
        roster.students.forEach((s: any, i: number) => { const sn: any = sSnaps[i]; if (sn?.exists) docs.set(s.uid, sn.data()); });
        const pSnaps: any[] = await Promise.all(roster.students.map((s: any) => subRef(paper, s.uid).get().catch(() => null)));
        parents = new Map(); roster.students.forEach((s: any, i: number) => { if (pSnaps[i]?.exists) parents.set(s.uid, pSnaps[i].data()); });
    }
    // Class-wide analysis: adds up the existing reports (no AI, no cost)
    async function openAnalysis() {
        el.innerHTML = shell('Class analysis · ' + paper.title, `Class ${esc(paper.className)}–${esc(paper.section)} · ${esc(paper.subject)}`, `<div class="osm-center"><div class="osm-spin"></div></div>`, 'Back to students');
        wireClose(el, () => { openPaper(roster, paper, teachers); });
        try {
            const students = await Promise.all(roster.students.map(async (s: any) => {
                const parent = parents.get(s.uid); let reports: any[] | null = null;
                if (parent) {
                    const r = await subRef(paper, s.uid).collection('detail').doc('report').get().catch(() => null);
                    reports = r?.exists ? (r.data().questionWiseReport || []).map((x: any) => ({ ...x })) : null;
                    if (reports) {
                        const marks = docs.get(s.uid)?.marks || {};
                        reports.forEach((x: any, i: number) => { if (marks[qk(i)]?.na) x._unattemptedAlt = true; });
                        let losers: Set<string>; try { losers = B.orLosers(reports.map(x => ({ questionNumber: x.questionNumber, marksAwarded: x.marksAwarded || 0, maxMarksForQuestion: x.maxMarksForQuestion, checkingInstructions: x.checkingInstructions || '' })), paper.questions); } catch { losers = new Set(); }
                        reports.forEach((x: any) => { x._runtimeOrLoser = losers.has(x.questionNumber) || !!x._unattemptedAlt; });
                    }
                }
                return { uid: s.uid, name: String(s.name || ''), roll: String(s.rollNumber ?? ''), score: parent ? Number(parent.overallScore) || 0 : null, max: declaredTotal(paper) || 0, reports };
            }));
            const bodyEl = el.querySelector('.osm-body') as HTMLElement;
            renderClassAnalysis(bodyEl, { title: paper.title, sub: '', students, onBack: () => openPaper(roster, paper, teachers), onOpen: (uid) => openDesk(roster, paper, teachers, uid, [uid], 'fb') });
        } catch (e: any) { toast('Could not build the analysis: ' + e.message, 'error'); openPaper(roster, paper, teachers); }
    }
    let autoAssigned = false;
    async function render() {
        const body = el.querySelector('.osm-body') as HTMLElement | null; if (!body) return;
        const scroll = (el as HTMLElement).scrollTop;
        const rows = roster.students.map((s: any) => {
            const d = docs.get(s.uid);
            const parent = parents.get(s.uid);
            const st = studentState(paper, d, meta, teachers, parent);
            const sc = scoreFor(paper, d?.marks);
            return { s, d, st, sc, parent };
        });
        {   // stable, same for every teacher: chosen column, then roll number, then name
            const rollOf = (r: any) => String(r.s.rollNumber ?? ''); const nm = (r: any) => String(r.s.name || '');
            const val = (r: any): number | string => sortKey === 'name' ? nm(r).toLowerCase() : sortKey === 'sheet' ? (r.d?.pages?.length || 0) : sortKey === 'marks' ? (r.d?.pages?.length ? Number(r.parent?.overallScore ?? r.sc.total) || 0 : -1) : sortKey === 'status' ? (STATUS_RANK[r.st.code] ?? 0) : rollOf(r);
            rows.sort((a: any, b: any) => { const x = val(a), y = val(b); const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }); return (c * sortDir) || rollOf(a).localeCompare(rollOf(b), undefined, { numeric: true }) || nm(a).localeCompare(nm(b)); });
        }
        const withSheets = rows.filter(r => r.d?.pages?.length);
        const readyN = rows.filter(r => r.st.code === 'ready').length;
        const analysedN = rows.filter(r => r.st.code === 'analysed' || r.st.code === 'published').length;
        const publishedN = rows.filter(r => r.st.code === 'published').length;
        const toPublish = rows.filter(r => r.st.code === 'analysed').map(r => r.s.uid);
        const allReady = withSheets.length > 0 && withSheets.every(r => ['ready', 'analysed', 'published'].includes(r.st.code));
        // One teacher on this subject: every question is theirs, picked and saved automatically (nothing to choose).
        const multiTeacher = teachers.length > 1;
        if (!multiTeacher && paper.questions.length && !(meta.assign?.[me.uid] || []).length && !autoAssigned) {
            autoAssigned = true;
            const all = paper.questions.map((_, i) => i);
            try { await metaRef(paper).set({ assign: { [me.uid]: all } }, { merge: true }); meta.assign = { ...(meta.assign || {}), [me.uid]: all }; } catch (e) { console.warn('[osm] auto-assign', e); }
        }
        const myAssign = meta.assign?.[me.uid] || []; const myStu = meta.students?.[me.uid] || [];
        const upCell = (s: any, d: any): string => {
            const j = upJobs.get(paper.id + '|' + s.uid);
            if (j && j.state === 'run') { const pct = j.total ? Math.round(j.done / j.total * 100) : 4; return `<div class="osm-upst run"><div class="osm-upbar"><i style="width:${pct}%"></i></div><span>${j.total ? `Uploading ${j.done} of ${j.total}` : esc(j.msg)}…</span></div>`; }
            if (j && j.state === 'err') return `<div class="osm-upst err"><b>✕ Upload failed</b> <button class="osm-link osm-retry" data-uid="${esc(s.uid)}">Retry</button> <button class="osm-link osm-up" data-uid="${esc(s.uid)}">Choose again</button><div class="osm-uperr">${esc(j.msg)}</div></div>`;
            return d?.pages?.length ? `<span class="osm-pgs ok">✓ ${d.pages.length} page${d.pages.length > 1 ? 's' : ''}</span> <button class="osm-link osm-up" data-uid="${esc(s.uid)}">Add / replace</button>` : `<button class="osm-btn small osm-up" data-uid="${esc(s.uid)}">${ICON.upload}<span>Upload sheet</span></button>`;
        };
        body.innerHTML = `
          <div class="osm-toolbar">
            <div class="osm-kpis">
              <div class="osm-kpi"><b>${withSheets.length}<small>/${roster.students.length}</small></b><span>sheets uploaded</span></div>
              <div class="osm-kpi"><b>${readyN}</b><span>ready for analysis</span></div>
              <div class="osm-kpi"><b>${analysedN}</b><span>analysed</span></div>
              <div class="osm-kpi"><b>${publishedN}</b><span>published</span></div>
            </div>
            <div class="osm-toolbar-btns">
              <span class="osm-sort"><label for="osm-sortsel">Sort by</label><select id="osm-sortsel">${([['roll', 'Roll'], ['name', 'Student name'], ['sheet', 'Answer sheet'], ['marks', 'Marks'], ['status', 'Status']] as [string, string][]).map(([k, l]) => `<option value="${k}" ${sortKey === k ? 'selected' : ''}>${l}</option>`).join('')}</select><button class="osm-btn small" id="osm-sortdir" title="Reverse the order">${sortDir === 1 ? '↑ A–Z / low–high' : '↓ Z–A / high–low'}</button></span>
              ${multiTeacher ? `<button class="osm-btn ${myAssign.length ? '' : 'primary osm-attn'}" id="osm-assign" title="Several teachers mark this paper: choose which questions are yours">${ICON.user}<span>${myAssign.length ? `My questions (${myAssign.length})` : 'Choose my questions'}</span></button>` : ''}
              ${analysedN ? `<button class="osm-btn primary" id="osm-classan" title="Class-wide strengths, weaknesses and topics to re-teach">${ICON.file}<span>Class analysis</span></button>` : ''}
              <button class="osm-btn" id="osm-howto" title="A quick walkthrough for teachers">?<span>How to mark</span></button>
              ${toPublish.length ? `<button class="osm-btn osm-pubsoft" id="osm-pub-all" title="Publishes every analysed report on this paper. Can be done later.">${ICON.send}<span>Publish all analysed (${toPublish.length})</span></button>` : ''}
            </div>
          </div>
          ${multiTeacher && !myAssign.length ? `<div class="osm-pickbanner">Several teachers mark this paper. <b>First choose your questions</b> (“Choose my questions”), so you are only asked about your own.</div>` : ''}
          <div class="osm-table-wrap"><table class="osm-table"><thead><tr>${([['roll', 'Roll'], ['name', 'Student'], ['sheet', 'Answer sheet'], ['marks', 'Marks']] as [string, string][]).map(([k, l]) => `<th class="osm-sortable" data-sort="${k}">${l}${sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}</th>`).join('')}<th>Teachers done</th><th class="osm-sortable" data-sort="status">Status${sortKey === 'status' ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}</th><th>Actions</th></tr></thead><tbody>
          ${rows.map(({ s, d, st, sc, parent }) => `<tr class="${myStu.length && !myStu.includes(s.uid) ? 'osm-dim' : ''}">
            <td>${esc(s.rollNumber || '')}</td><td class="osm-nm">${esc(s.name)}</td>
            <td data-upcell="${esc(s.uid)}">${upCell(s, d)}</td>
            <td>${d?.pages?.length ? `<b>${fmt1(parent?.overallScore ?? sc.total)}</b> / ${declaredTotal(paper) || '—'}` : '—'}</td>
            <td>${teachers.map(t => `<span class="osm-chip ${st.doneBy.includes(t.uid) ? 'on' : ''}" title="${esc(t.name)}">${esc(shortName(t.name, teachers))}${st.doneBy.includes(t.uid) ? ' ✓' : ''}</span>`).join('')}</td>
            <td><span class="osm-badge ${st.code}"><i></i>${esc(st.label)}</span></td>
            <td class="osm-act">${d?.pages?.length ? `<button class="osm-btn primary osm-markbtn osm-open" data-uid="${esc(s.uid)}">${ICON.pen}<span>Mark</span></button>` : ''}${parent ? `<button class="osm-btn soft osm-fbbtn" data-uid="${esc(s.uid)}">${ICON.msg}<span>Feedback</span></button>${parent.published ? `<button class="osm-btn quiet osm-unpub" data-uid="${esc(s.uid)}" title="Remove from the student's app">${ICON.eyeoff}<span>Unpublish</span></button>` : `<button class="osm-btn outline osm-pub" data-uid="${esc(s.uid)}">${ICON.send}<span>Publish</span></button>`}` : ''}</td>
          </tr>`).join('')}
          </tbody></table></div>`;
        (el as HTMLElement).scrollTop = scroll;
        const setSort = (k: SortKey, d?: 1 | -1) => { sortDir = d ?? (k === sortKey ? (sortDir === 1 ? -1 : 1) : 1); sortKey = k; try { localStorage.setItem('osm-sort-v1', JSON.stringify({ k: sortKey, d: sortDir })); } catch { /* ignore */ } render(); };
        body.querySelector<HTMLSelectElement>('#osm-sortsel')?.addEventListener('change', e => setSort((e.target as HTMLSelectElement).value as SortKey, 1));
        body.querySelector('#osm-sortdir')?.addEventListener('click', () => setSort(sortKey, sortDir === 1 ? -1 : 1));
        body.querySelectorAll<HTMLElement>('th.osm-sortable').forEach(th => th.addEventListener('click', () => setSort(th.dataset.sort as SortKey)));
        body.querySelector('#osm-howto')?.addEventListener('click', () => openTour());
        body.querySelector('#osm-classan')?.addEventListener('click', () => openAnalysis());
        body.querySelector('#osm-assign')?.addEventListener('click', () => openAssignModal(paper, meta, me.uid, roster.students, async (list, stu) => {
            await metaRef(paper).set({ assign: { [me.uid]: list }, students: { [me.uid]: stu } }, { merge: true });
            await reload(); await render();
        }));
        const order = rows.filter(r => r.d?.pages?.length && (!myStu.length || myStu.includes(r.s.uid))).map(r => r.s.uid);
        body.querySelectorAll<HTMLButtonElement>('.osm-open').forEach(b => b.addEventListener('click', () => openDesk(roster, paper, teachers, b.dataset.uid!, order)));
        body.querySelectorAll<HTMLButtonElement>('.osm-fbbtn').forEach(b => b.addEventListener('click', () => openDesk(roster, paper, teachers, b.dataset.uid!, order, 'fb')));
        const doPublish = async (uids: string[]) => {
            if (!uids.length || !confirm(`Publish ${uids.length} report${uids.length > 1 ? 's' : ''} to the student${uids.length > 1 ? 's' : ''}? They will see the marks and feedback in their app.`)) return;
            busyFlag = true; let ok = 0; busy(true, 'Publishing…');
            try { for (const u of uids) { try { await publishOne(paper, u); ok++; } catch (e: any) { toast('Could not publish: ' + e.message, 'error'); } } await reload(); await render(); toast(`Published ${ok} report${ok === 1 ? '' : 's'}.`, 'success'); }
            finally { busy(false); busyFlag = false; }
        };
        body.querySelectorAll<HTMLButtonElement>('.osm-pub').forEach(b => b.addEventListener('click', () => doPublish([b.dataset.uid!])));
        body.querySelector('#osm-pub-all')?.addEventListener('click', () => doPublish(toPublish));
        body.querySelectorAll<HTMLButtonElement>('.osm-unpub').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('Unpublish this report? The student will no longer see it. Nothing is deleted.')) return;
            busyFlag = true; busy(true, 'Unpublishing…'); try { await unpublishOne(paper, b.dataset.uid!); await reload(); await render(); toast('Unpublished.', 'info'); } catch (e: any) { toast('Could not unpublish: ' + e.message, 'error'); } finally { busy(false); busyFlag = false; }
        }));
        let refreshQ: Promise<void> = Promise.resolve();
        const startUpload = (stu: any, files: File[], mode: 'add' | 'replace') => {
            const key = paper.id + '|' + stu.uid; const job: UpJob = { stu, files, mode, state: 'run', done: 0, total: 0, msg: 'Preparing pages' }; upJobs.set(key, job); upPaint?.(stu.uid);
            saveSheets(paper, stu, files, mode, p => { Object.assign(job, p); upPaint?.(stu.uid); }).then(() => {
                if (job.state !== 'ok') return;
                refreshQ = refreshQ.then(async () => { try { await reload(); upJobs.delete(key); if (document.getElementById('osm-root')) await render(); } catch { upJobs.delete(key); } });
            });
        };
        const wireUp = (root: ParentNode) => {
            root.querySelectorAll<HTMLButtonElement>('.osm-up').forEach(b => b.addEventListener('click', () => {
                const stu = roster.students.find((x: any) => x.uid === b.dataset.uid);
                openUploadModal(paper, stu, docs.get(b.dataset.uid!)?.pages?.length || 0, (files, mode) => startUpload(stu, files, mode));
            }));
            root.querySelectorAll<HTMLButtonElement>('.osm-retry').forEach(b => b.addEventListener('click', () => { const j = upJobs.get(paper.id + '|' + b.dataset.uid); if (j) startUpload(j.stu, j.files, j.mode); }));
        };
        wireUp(body);
        upPaint = (uid: string) => { const td = document.querySelector(`#osm-root td[data-upcell="${CSS.escape(uid)}"]`); const r = rows.find(x => x.s.uid === uid); if (td && r) { td.innerHTML = upCell(r.s, r.d); wireUp(td); } };
        // keep the explicit readiness flag in sync (idempotent) so analysis can find ready papers fast
        if (readFailed && !warnedRead) { warnedRead = true; toast('Some students could not be loaded — go back and open the paper again before relying on the status.', 'error'); }
        if (!readFailed && allReady !== !!meta.readyForAnalysis) {
            metaRef(paper).set({ readyForAnalysis: allReady, readyCount: readyN, sheetCount: withSheets.length, readyAt: allReady ? Date.now() : null }, { merge: true }).catch(() => { /* non-fatal */ });
        }
    }
    try {
        await reload(); await render();
        // Keeps co-teachers' progress current without a Refresh button (paused while a dialog is open).
        const iv = setInterval(async () => { if (busyFlag || document.querySelector('.osm-modal') || !document.getElementById('osm-root') || document.hidden) return; busyFlag = true; try { await reload(); await render(); } catch { /* try again next tick */ } finally { busyFlag = false; } }, 30000);
        stopListeners.push(() => clearInterval(iv));
    }
    catch (e: any) { (el.querySelector('.osm-body') as HTMLElement).innerHTML = `<div class="osm-empty"><p>Could not load this paper.</p><p class="osm-sub">${esc(e?.message)}</p></div>`; }
}

// Upload dialog: PDF (split into page images, exactly like Exams) or photos. When a sheet already exists the teacher
// must choose: add these pages to the end, or replace the whole sheet.
function openUploadModal(paper: Paper, stu: any, existing: number, onStart: (files: File[], mode: 'add' | 'replace') => void) {
    const m = document.createElement('div'); m.className = 'osm-modal';
    m.innerHTML = `<div class="osm-modal-card">
      <h3>${existing ? 'Add or replace' : 'Upload'} answer sheet</h3>
      <p class="osm-sub">${esc(stu?.name || '')} · Roll ${esc(stu?.rollNumber || '')}${existing ? ` · currently ${existing} page${existing > 1 ? 's' : ''}` : ''}</p>
      <div class="osm-drop" id="osm-drop"><div>📄 Drop a PDF or page photos here</div><label class="osm-btn small" for="osm-file">Choose files</label><input id="osm-file" type="file" multiple accept="image/*,application/pdf" hidden></div>
      <ul class="osm-files" id="osm-files"></ul>
      ${existing ? `<div class="osm-choice">
        <label class="osm-radio"><input type="radio" name="osm-mode" value="add" checked><span><b>Add pages</b> — put the selected pages after the existing ${existing}. Use this for a page that was missed.</span></label>
        <label class="osm-radio"><input type="radio" name="osm-mode" value="replace"><span><b>Replace whole sheet</b> — remove the current pages and use only the selected files. Marks stay; pen marks on the old pages are removed.</span></label></div>` : ''}
      <div class="osm-actions"><button class="osm-btn" id="osm-u-cancel">Cancel</button><button class="osm-btn primary" id="osm-u-go" disabled>Upload</button></div></div>`;
    document.body.appendChild(m);
    let files: File[] = [];
    const list = m.querySelector('#osm-files') as HTMLElement; const go = m.querySelector('#osm-u-go') as HTMLButtonElement;
    const setFiles = (fl: FileList | File[]) => {
        files = Array.from(fl).filter(f => f.type === 'application/pdf' || f.type.startsWith('image/'));
        files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        list.innerHTML = files.map(f => `<li>${f.type === 'application/pdf' ? '📕' : '🖼️'} ${esc(f.name)} <small>${(f.size / 1048576).toFixed(1)} MB</small></li>`).join('');
        go.disabled = !files.length;
    };
    (m.querySelector('#osm-file') as HTMLInputElement).addEventListener('change', e => setFiles((e.target as HTMLInputElement).files || []));
    const drop = m.querySelector('#osm-drop') as HTMLElement;
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); setFiles((e as DragEvent).dataTransfer?.files || []); });
    m.querySelector('#osm-u-cancel')!.addEventListener('click', () => m.remove());
    go.addEventListener('click', async () => {
        const mode = (m.querySelector('input[name="osm-mode"]:checked') as HTMLInputElement | null)?.value === 'replace' ? 'replace' : 'add';
        if (mode === 'replace' && !confirm(`Replace the whole sheet for ${stu?.name || 'this student'}? The ${existing} current page(s) will be removed from this paper and pen marks on them are deleted. Marks already given are kept.`)) return;
        go.disabled = true; m.remove();
        onStart(files, mode);   // runs in the background; the row shows its own progress
    });
}

// Same storage location + PDF→image handling as the Exams answer-sheet upload:
//   gradedReports/{teacherUid}/{paperId}/{studentUid}/{time}_{filename}   (PDF pages are already enhanced, photos are processed)
// A message that stays until the teacher reads it (a toast fades; a failed upload must not be missed).
function alertBox(title: string, html: string) {
    const m = document.createElement('div'); m.className = 'osm-modal'; m.style.zIndex = '100002';
    m.innerHTML = `<div class="osm-modal-card"><h3>${esc(title)}</h3><div style="font-size:.9rem;line-height:1.55">${html}</div><div class="osm-actions"><button class="osm-btn primary" id="osm-al-ok">OK</button></div></div>`;
    document.body.appendChild(m); m.querySelector('#osm-al-ok')!.addEventListener('click', () => m.remove());
}
// Every page is uploaded, checked against what storage actually received, and retried if the network hiccups.
// All-or-nothing: if even one page cannot be stored, NOTHING is saved for the student and the teacher is told exactly which pages to upload again.
async function saveSheets(paper: Paper, stu: any, files: File[], mode: 'add' | 'replace', prog?: (p: Partial<UpJob>) => void) {
    const say = (t: string, done = 0, total = 0) => { if (prog) prog({ state: 'run', msg: t, done, total }); else busy(true, t); };
    const fail = (title: string, html: string) => { if (prog) prog({ state: 'err', msg: title + ' — ' + html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }); else alertBox(title, html); };
    const me = B.teacher()!; const studentUid = stu?.uid;
    if (!navigator.onLine) { fail('No internet connection', 'You appear to be offline, so nothing was uploaded. Please reconnect and upload this student’s sheets again.'); return; }
    say('Preparing pages');
    try {
        const expanded: File[] = [];
        for (const f of files) { if (f.type === 'application/pdf') expanded.push(...await B.pdfToImages(f)); else expanded.push(f); }
        if (!expanded.length) { fail('Nothing to upload', 'No pages were found in the file(s) you chose.'); return; }
        const total = expanded.length; let done = 0; const failed: { n: number; why: string }[] = [];
        const pages: ({ path: string; url: string } | null)[] = new Array(total).fill(null);
        const uploadOne = async (idx: number) => {
            const img = expanded[idx];
            const up = img.name.includes('_page_') ? img : await B.processImage(img).catch(() => img);
            const path = `gradedReports/${me.uid}/${paper.id}/${studentUid}/${img.lastModified || Date.now()}_${Date.now().toString(36)}${idx}_${img.name.replace(/[^\w.\-]/g, '_')}`;
            let lastErr: any = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const ref = B.storage.ref(path); await ref.put(up);
                    const meta = await ref.getMetadata();
                    if (Number(meta.size) !== up.size) throw new Error(`stored ${meta.size} of ${up.size} bytes`);   // a truncated upload is never accepted
                    const url = await ref.getDownloadURL(); pages[idx] = { path, url }; done++; say('Uploading', done, total); return;
                } catch (e: any) { lastErr = e; await new Promise(r => setTimeout(r, 800 * attempt)); }
            }
            failed.push({ n: idx + 1, why: lastErr?.message || 'network error' });
        };
        // 3 pages at a time keeps a weak connection from timing out
        let next = 0; await Promise.all(Array.from({ length: Math.min(3, total) }, async () => { while (next < total) { const i = next++; await uploadOne(i); } }));
        if (failed.length) {
            failed.sort((a, b) => a.n - b.n);
            fail('Upload incomplete — nothing was saved', `${failed.length} of ${total} page${total > 1 ? 's' : ''} could not be uploaded (page${failed.length > 1 ? 's' : ''} ${failed.map(f => f.n).join(', ')}). This is usually a network problem. <b>Please upload this student’s sheets again.</b> No partial sheet was saved for ${esc(stu?.name || 'this student')}.`);
            return;
        }
        const good = pages as { path: string; url: string }[];
        const base = { studentUid, studentName: stu?.name || '', rollNumber: stu?.rollNumber || '', uploadedBy: me.uid, updatedAt: Date.now() };
        if (mode === 'replace') {
            // pen strokes were drawn on the old pages — remove them first so they cannot land on the new pages.
            // pagesVersion also makes any ink saved later from an already-open desk (old pages) be ignored on load.
            let inkNote = '';
            try {
                const det = await paperRef(paper.owner, paper.id).collection('submissions').doc(studentUid).collection('detail').get();
                await Promise.all(det.docs.filter((d: any) => d.id.startsWith('osmInk_')).map((d: any) => d.ref.delete()));
            } catch (e: any) { inkNote = ' Old pen marks could not be deleted, but they will be ignored.'; console.warn('[osm] ink cleanup', e); }
            await stuRef(paper, studentUid).set({ ...base, pages: good, pagesVersion: Date.now() }, { merge: true });
            if (inkNote) toast(inkNote.trim(), 'info');
        } else {
            // arrayUnion: two teachers adding pages to the same student at once can never drop each other's pages
            await stuRef(paper, studentUid).set({ ...base, pages: B.FieldValue.arrayUnion(...good) }, { merge: true });
        }
        // read it back: every uploaded page must now be on the student's sheet
        const back = (await stuRef(paper, studentUid).get()).data() || {}; const have = new Set((back.pages || []).map((x: any) => x.url));
        const lost = good.filter(g => !have.has(g.url)).length;
        if (lost) { fail('Please check this upload', `${lost} page${lost > 1 ? 's were' : ' was'} not found after saving. Please upload this student’s sheets again.`); return; }
        if (prog) prog({ state: 'ok', done: good.length, total: good.length, msg: 'Saved' });
        toast(mode === 'replace' ? `Sheet replaced — all ${good.length} page${good.length > 1 ? 's' : ''} stored and checked.` : `Added ${good.length} page${good.length > 1 ? 's' : ''} for ${stu?.name || 'student'} — all stored and checked (sheet now has ${(back.pages || []).length}).`, 'success');
    } catch (e: any) { console.error('[osm] upload failed', e); fail('Upload failed — nothing was saved', `${esc(e.message || 'Unknown error')}. Please upload this student’s sheets again.`); }
    finally { if (!prog) busy(false); }
}

function openAssignModal(paper: Paper, meta: Meta, uid: string, students: any[], onSave: (list: number[], stu: string[]) => Promise<void>) {
    const cur = new Set(meta.assign?.[uid] || []); const curStu = new Set(meta.students?.[uid] || []);
    const m = document.createElement('div'); m.className = 'osm-modal';
    m.innerHTML = `<div class="osm-modal-card">
      <h3>Which questions are yours?</h3>
      <p class="osm-sub">Co-teachers mark different questions. You can still see everyone's marks. Leave all unticked if you will mark the whole paper.</p>
      <div class="osm-range"><label>From <select id="osm-from">${paper.questions.map((q, i) => `<option value="${i}">${esc(q.questionNumber || i + 1)}</option>`).join('')}</select></label>
      <label>to <select id="osm-to">${paper.questions.map((q, i) => `<option value="${i}" ${i === paper.questions.length - 1 ? 'selected' : ''}>${esc(q.questionNumber || i + 1)}</option>`).join('')}</select></label>
      <button class="osm-btn small" id="osm-rng">Select range</button> <button class="osm-btn small" id="osm-none">Clear</button></div>
      <div class="osm-checks">${paper.questions.map((q, i) => `<label class="osm-check"><input type="checkbox" data-i="${i}" ${cur.has(i) ? 'checked' : ''}> ${esc(q.questionNumber || i + 1)}<small>${fmt1(qMax(q))}</small></label>`).join('')}</div>
      <details class="osm-stu-det" ${curStu.size ? 'open' : ''}><summary>My students (optional)</summary>
        <p class="osm-sub">Only needed when you and another teacher split the <b>class</b> between you (each marks different students). Leave all unticked to mark every student. Teachers who share the questions of one paper do not need this.</p>
        <div class="osm-range"><button class="osm-btn small" id="osm-stu-all">Select all</button> <button class="osm-btn small" id="osm-stu-none">Clear</button></div>
        <div class="osm-checks osm-stu-checks">${students.map((st: any) => `<label class="osm-check"><input type="checkbox" data-u="${esc(st.uid)}" ${curStu.has(st.uid) ? 'checked' : ''}> ${esc(st.name || '')}<small>${esc(st.rollNumber || '')}</small></label>`).join('')}</div>
      </details>
      <div class="osm-actions"><button class="osm-btn" id="osm-m-cancel">Cancel</button><button class="osm-btn primary" id="osm-m-save">Save</button></div></div>`;
    document.body.appendChild(m);
    const sboxes = () => Array.from(m.querySelectorAll<HTMLInputElement>('.osm-stu-checks input'));
    m.querySelector('#osm-stu-all')!.addEventListener('click', () => sboxes().forEach(c => c.checked = true));
    m.querySelector('#osm-stu-none')!.addEventListener('click', () => sboxes().forEach(c => c.checked = false));
    const boxes = () => Array.from(m.querySelectorAll<HTMLInputElement>('.osm-checks:not(.osm-stu-checks) input'));
    m.querySelector('#osm-rng')!.addEventListener('click', () => {
        let a = Number((m.querySelector('#osm-from') as HTMLSelectElement).value), b = Number((m.querySelector('#osm-to') as HTMLSelectElement).value);
        if (a > b) [a, b] = [b, a]; boxes().forEach(c => { const i = Number(c.dataset.i); if (i >= a && i <= b) c.checked = true; });
    });
    m.querySelector('#osm-none')!.addEventListener('click', () => boxes().forEach(c => c.checked = false));
    m.querySelector('#osm-m-cancel')!.addEventListener('click', () => m.remove());
    m.querySelector('#osm-m-save')!.addEventListener('click', async () => {
        const list = boxes().filter(c => c.checked).map(c => Number(c.dataset.i));
        const stu = sboxes().filter(c => c.checked).map(c => c.dataset.u!);
        try { await onSave(list, stu); m.remove(); toast('Saved.', 'success'); } catch (e: any) { toast('Could not save: ' + e.message, 'error'); }
    });
}


// ═════════════════ Durable outbox + change log ═════════════════
// Every change a teacher makes (mark, reason note, feedback edit, pen/tick/cross) is first written to this device (localStorage),
// then sent to the cloud. It is removed from the device ONLY after the cloud confirms it. If the connection drops or the page is
// refreshed, the change is still here and is sent automatically when possible (also next time the teacher signs in).
// Each confirmed change also appends a line to the history (who / what / which question / when).
type ObOp = { key: string; kind: 'mark' | 'note' | 'ink' | 'fb' | 'fbov' | 'log'; by: string; owner: string; pid: string; suid: string; at: number; data: any };
const OB_KEY = 'osm-outbox-v1';
const ob = { ops: new Map<string, ObOp>(), loaded: false, running: false, timer: null as any, fails: 0, lastErr: '', memOnly: false, subs: new Set<() => void>(), poll: null as any };
function obLoad() {
    if (ob.loaded) return; ob.loaded = true;
    try { (JSON.parse(localStorage.getItem(OB_KEY) || '[]') as ObOp[]).forEach(o => { if (o && o.key) ob.ops.set(o.key, o); }); } catch { /* */ }
    window.addEventListener('online', () => { ob.fails = 0; obSchedule(300); });
    ob.poll = setInterval(() => { if (ob.ops.size && !ob.running) obSchedule(0); }, 20000);
}
function obSave() { try { localStorage.setItem(OB_KEY, JSON.stringify([...ob.ops.values()])); ob.memOnly = false; } catch { ob.memOnly = true; } }
const obNotify = () => ob.subs.forEach(f => { try { f(); } catch { /* */ } });
const obPendingCount = () => [...ob.ops.values()].filter(o => o.kind !== 'log').length;
function obSchedule(delay: number) { clearTimeout(ob.timer); ob.timer = setTimeout(() => { obDrain(); }, delay); }
function obEnqueue(op: ObOp, delay = 600) {
    obLoad(); const old = ob.ops.get(op.key);
    if (old) {   // a newer edit of the same thing replaces the older one; keep what the history needs
        if (op.kind === 'fb') op.data = { items: { ...old.data.items, ...op.data.items } };
        if (op.kind === 'mark') { op.data.prev = old.data.prev; op.data.reopen = !!(op.data.reopen || old.data.reopen); }
        if (op.kind === 'note') op.data.prev = old.data.prev;
        if (op.kind === 'ink') { const acc: any = JSON.parse(JSON.stringify(old.data.acc || {})); Object.entries(op.data.acc || {}).forEach(([pg, c]: any) => { acc[pg] ||= {}; Object.entries(c).forEach(([k, n]: any) => { acc[pg][k] = (acc[pg][k] || 0) + n; }); }); op.data.acc = acc; }
    }
    ob.ops.set(op.key, op); obSave(); obNotify(); obSchedule(delay);
}
function obLog(o: { by: string; owner: string; pid: string; suid: string }, ev: { type: string; q?: string; page?: number; text: string; v?: number | string }) {
    const me = B.teacher(); const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    obEnqueue({ key: 'log:' + id, kind: 'log', by: o.by, owner: o.owner, pid: o.pid, suid: o.suid, at: Date.now(), data: { id, t: Date.now(), by: o.by, n: me?.name || '', ...ev } }, 800);
}
const obFmt = (v: any) => v === 'na' ? 'not attempted' : v === undefined || v === null ? 'not marked' : String(Math.round(Number(v) * 100) / 100);
async function obExec(o: ObOp) {
    const P = { owner: o.owner, id: o.pid } as any as Paper; const d = o.data; const who = { by: o.by, owner: o.owner, pid: o.pid, suid: o.suid };
    if (o.kind === 'mark') {
        const patch: any = { studentUid: o.suid, studentName: d.studentName || '', rollNumber: d.rollNumber || '', marks: { [d.qk]: d.entry ? d.entry : B.FieldValue.delete() }, updatedAt: Date.now() };
        if (d.reopen) patch.done = { [o.by]: B.FieldValue.delete() };
        await stuRef(P, o.suid).set(patch, { merge: true });
        if (!d.entry) obLog(who, { type: 'mark', q: d.qLabel, text: `${d.qLabel}: no longer “not attempted” (back to not marked)` });
        else if (d.entry.na) obLog(who, { type: 'mark', q: d.qLabel, text: `${d.qLabel}: marked as NOT ATTEMPTED (no marks, not counted as a weakness)` });
        else if (d.prev !== d.entry.v) obLog(who, { type: 'mark', q: d.qLabel, v: d.entry.v, text: `${d.qLabel}: marks ${obFmt(d.prev)} → ${obFmt(d.entry.v)}` });
    } else if (o.kind === 'note') {
        await stuRef(P, o.suid).set({ notes: { [d.qk]: d.entry ? d.entry : B.FieldValue.delete() }, updatedAt: Date.now() }, { merge: true });
        obLog(who, { type: 'note', q: d.qLabel, text: `${d.qLabel}: ${d.entry ? (d.prev ? 'edited' : 'added') : 'removed'} the reason note` });
    } else if (o.kind === 'ink') {
        let pages = d.pages;
        if (d.union) {   // the saved marks could not be read earlier: merge instead of replacing, so nothing is lost
            const snap = await inkRef(P, o.suid, o.by).get(); const sp = snap.exists ? (snap.data().pages || {}) : {};
            pages = { ...sp }; Object.entries(d.pages || {}).forEach(([pg, arr]: any) => { const have = (pages[pg] || []) as any[]; pages[pg] = [...have, ...arr.filter((c: any) => !have.some((a: any) => JSON.stringify(a) === JSON.stringify(c)))]; });
        }
        await inkRef(P, o.suid, o.by).set({ teacherUid: o.by, teacherName: d.teacherName, pages, pv: d.pv ?? null, updatedAt: Date.now() });
        const names: Record<string, string> = { pen: 'pen mark', note: 'text note', tick: 'tick', cross: 'cross' };
        Object.entries(d.acc || {}).forEach(([pg, c]: any) => {
            const add: string[] = [], rem: string[] = [];
            Object.entries(c).forEach(([k, n]: any) => { if (n > 0) add.push(`${n} ${names[k]}${n > 1 ? 's' : ''}`); else if (n < 0) rem.push(`${-n} ${names[k]}${n < -1 ? 's' : ''}`); });
            if (add.length || rem.length) obLog(who, { type: 'ink', page: Number(pg) + 1, text: `Page ${Number(pg) + 1}: ${[add.length ? 'added ' + add.join(', ') : '', rem.length ? 'removed ' + rem.join(', ') : ''].filter(Boolean).join('; ')}` });
        });
    } else if (o.kind === 'fb') {
        const rr = paperRef(o.owner, o.pid).collection('submissions').doc(o.suid).collection('detail').doc('report'); const pr = paperRef(o.owner, o.pid).collection('submissions').doc(o.suid);
        const changed: string[] = [];
        await B.db.runTransaction(async (tx: any) => {
            changed.length = 0;
            const snap = await tx.get(rr); const arr: any[] = snap.exists ? (snap.data().questionWiseReport || []) : [];
            Object.entries(d.items).forEach(([qn, it]: any) => {
                const idx = arr.findIndex(x => String(x.questionNumber) === qn); if (idx < 0) return;
                const a = arr[idx], b = it.obj;
                if ((a.whyLost || '') !== (b.whyLost || '') || (a.howToImprove || '') !== (b.howToImprove || '') || (a.teacherNote || '') !== (b.teacherNote || '')) changed.push(it.label);
                arr[idx] = b;
            });
            tx.set(rr, { questionWiseReport: arr }, { merge: true });
            tx.update(pr, { overallScore: arr.filter(x => !x._runtimeOrLoser).reduce((s2: number, x: any) => s2 + (Number(x.marksAwarded) || 0), 0) });
        });
        changed.forEach(q => obLog(who, { type: 'feedback', q, text: `${q}: edited the feedback shown to the student` }));
    } else if (o.kind === 'fbov') {
        await paperRef(o.owner, o.pid).collection('submissions').doc(o.suid).update(d.fields);
        obLog(who, { type: 'feedback', text: 'Edited the overall summary / strengths / areas / next steps' });
    } else if (o.kind === 'log') {
        await paperRef(o.owner, o.pid).collection('submissions').doc(o.suid).collection('detail').doc('osmLog_' + o.by).set({ teacherUid: o.by, teacherName: d.n, events: B.FieldValue.arrayUnion(d), updatedAt: Date.now() }, { merge: true });
    }
}
async function obDrain(): Promise<void> {
    obLoad(); const me = B.teacher(); if (!me || ob.running) return;
    ob.running = true;
    try {
        for (;;) {
            const next = [...ob.ops.values()].find(o => o.by === me.uid); if (!next) break;
            try {
                await Promise.race([obExec(next), new Promise((_, rej) => setTimeout(() => rej(new Error('no reply from the server (offline?)')), 15000))]);
                if (ob.ops.get(next.key) === next) ob.ops.delete(next.key);   // a newer edit of the same item stays queued and is sent next
                ob.fails = 0; ob.lastErr = ''; obSave(); obNotify();
            } catch (e: any) {
                ob.fails++; ob.lastErr = e?.message || String(e); obNotify();
                obSchedule(Math.min(30000, 2000 * 2 ** Math.min(ob.fails, 4))); break;
            }
        }
    } finally { ob.running = false; obNotify(); }
}
async function obFlush() {
    clearTimeout(ob.timer);
    for (let k = 0; k < 3; k++) { while (ob.running) await new Promise(r => setTimeout(r, 80)); await obDrain(); if (![...ob.ops.values()].some(o => o.by === B.teacher()?.uid)) break; }
}

// ───────── "How to mark" walkthrough for teachers ─────────
const TOUR_STEPS: { t: string; b: string }[] = [
    { t: '1 · Choose your questions', b: 'On the paper screen click <b>My questions</b> and tick only the questions <i>you</i> will mark (or a range). Without this, the paper keeps asking you about every question. You can still see everyone’s marks.' },
    { t: '2 · Give marks', b: 'Open a student with <b>Mark</b>. For each question use <b>− / +</b> (half a mark), click a mark button (0, 0.5, 1 …), press <b>Full</b>, or type the number. <b>N/A</b> means the student did not attempt it (greyed, no marks, never counted as a weakness).' },
    { t: '3 · Colours', b: '<span style="color:#2e9e4f;font-weight:700">Green</span> = full marks, <span style="color:#d99100;font-weight:700">yellow</span> = some marks, <span style="color:#e53935;font-weight:700">red</span> = zero, grey = not attempted / not marked yet.' },
    { t: '4 · Why marks were cut', b: 'Tap the small <b>Why marks cut?</b> button under a question and write — or press the 🎤 microphone and <b>speak</b>. The student never sees this; the feedback is built on it.' },
    { t: '5 · Write on the sheet', b: 'Tools on the left: <b>Pen</b>, <b>Aa Note</b> (type, drag to move), <b>Tick</b> and <b>Cross</b> (click anywhere to place), <b>Erase</b> (click near a mark). Choose <b>colour</b> and <b>Thin / Medium / Thick</b>. <b>Ctrl+Z</b> (or Undo) takes back your last action. Click the active tool again to just scroll the page.' },
    { t: '6 · Your questions, and the others', b: 'In the question list on the left, <b>your</b> questions have a blue ring; others are faded. Everyone sees everyone’s marks, notes and annotations live — nothing you do overwrites another teacher.' },
    { t: '7 · Completed', b: 'When your questions are done click <b>Completed</b>. Your name then turns <span style="color:#1e8e4e;font-weight:700">green</span> at the bottom. Until you click it, your part is not complete. Changing a mark afterwards reopens it — click Completed again.' },
    { t: '8 · Always saved', b: 'The top bar says <b>“All changes saved”</b>. If it shows a warning, do not worry: your work is kept on this computer and is sent automatically when the connection returns. <b>History</b> shows every change — who, what, when — and highlights any question two teachers both marked.' },
];
function openTour(startAt = 0) {
    document.querySelectorAll('.osm-tour-back').forEach(n => n.remove());
    let i = startAt; const back = document.createElement('div'); back.className = 'osm-tour-back';
    const draw = () => {
        const st = TOUR_STEPS[i];
        back.innerHTML = `<div class="osm-tour"><div class="osm-tour-h"><b>How to mark a paper</b><span>${i + 1} of ${TOUR_STEPS.length}</span></div><div class="osm-tour-body"><h4>${st.t}</h4><p>${st.b}</p></div>
          <div class="osm-tour-dots">${TOUR_STEPS.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
          <div class="osm-tour-f"><button class="osm-btn small" id="tour-skip">Close</button><span style="flex:1"></span><button class="osm-btn small" id="tour-prev" ${i === 0 ? 'disabled' : ''}>Back</button><button class="osm-btn small primary" id="tour-next">${i === TOUR_STEPS.length - 1 ? 'Done' : 'Next'}</button></div></div>`;
        back.querySelector('#tour-skip')!.addEventListener('click', () => back.remove());
        back.querySelector('#tour-prev')!.addEventListener('click', () => { i = Math.max(0, i - 1); draw(); });
        back.querySelector('#tour-next')!.addEventListener('click', () => { if (i >= TOUR_STEPS.length - 1) back.remove(); else { i++; draw(); } });
    };
    draw(); document.body.appendChild(back); try { localStorage.setItem('osm-tour-seen', '1'); } catch { /* */ }
}

// ───────────────────────── SCREEN C: marking desk ─────────────────────────
type InkStroke = { c: string; w: number; d?: string; t?: string; x?: number; y?: number; k?: 'tick' | 'cross' };   // a pen stroke (d) or a text note (t at x,y)
async function openDesk(roster: Roster, paper: Paper, teachers: { uid: string; name: string }[], studentUid: string, order: string[], startView: 'mark' | 'fb' = 'mark') {
    clearListeners();
    const el = ensureRoot();
    const me = B.teacher()!;
    const stu = roster.students.find((s: any) => s.uid === studentUid);
    el.innerHTML = `<div class="osm-center"><div class="osm-spin"></div></div>`;
    let meta: Meta = {}; let doc: StuDoc;
    try {
        const [m, d] = await Promise.all([metaRef(paper).get(), stuRef(paper, studentUid).get()]);
        meta = m.exists ? m.data() : {}; doc = d.exists ? d.data() : { studentUid, studentName: stu?.name, rollNumber: stu?.rollNumber, pages: [] };
    } catch (e: any) { el.innerHTML = `<div class="osm-empty"><p>Could not open this paper.</p><p class="osm-sub">${esc(e.message)}</p></div>`; return; }

    // Step 2 result (written by Claude): report + analysis. Present only after the analysis has been done.
    let fbParent: any = null; let fbReport: any[] | null = null;
    try {
        const sref = subRef(paper, studentUid);
        const [ps, rs] = await Promise.all([sref.get(), sref.collection('detail').doc('report').get()]);
        if (ps.exists && rs.exists) { fbParent = ps.data(); fbReport = rs.data().questionWiseReport || []; }
    } catch (e) { console.warn('[osm] analysis not loaded', e); }
    // changes made on this device that the cloud has not confirmed yet are shown as they were left (never lost on refresh)
    obLoad(); void obDrain();
    const pendingInk: any = (() => { let r: any = null; ob.ops.forEach(o => { if (o.suid !== studentUid || o.pid !== paper.id || o.by !== me.uid) return;
        if (o.kind === 'mark') { if (o.data.entry) (doc.marks ||= {})[o.data.qk] = o.data.entry; else if (doc.marks) delete doc.marks[o.data.qk]; }
        else if (o.kind === 'note') { if (o.data.entry) (doc.notes ||= {})[o.data.qk] = o.data.entry; else if (doc.notes) delete doc.notes[o.data.qk]; }
        else if (o.kind === 'fb' && fbReport) Object.entries(o.data.items).forEach(([qn, it]: any) => { const ix = fbReport!.findIndex(x => String(x.questionNumber) === qn); if (ix >= 0) fbReport![ix] = it.obj; });
        else if (o.kind === 'fbov' && fbParent) Object.assign(fbParent, o.data.fields);
        else if (o.kind === 'ink') r = o.data.pages; }); return r; })();
    let view: 'mark' | 'fb' = startView === 'fb' && fbReport ? 'fb' : 'mark';

    const myIdx = new Set<number>(meta.assign?.[me.uid] || []);
    const hasAssign = myIdx.size > 0;
    const multiT = teachers.length > 1;   // 'your questions' signals only matter when teachers share the paper
    const showMine = hasAssign && multiT;
    let unlockAll = !hasAssign;
    const pos = order.indexOf(studentUid);
    const inks: Record<string, Record<string, InkStroke[]>> = {};   // teacherUid -> page -> strokes
    if (pendingInk) inks[me.uid] = JSON.parse(JSON.stringify(pendingInk));
    const nameOf = (u: string) => teachers.find(t => t.uid === u)?.name || 'Teacher';
    let zoom = Number((() => { try { return localStorage.getItem('osm-zoom'); } catch { return null; } })()) || 100;
    let tool: 'none' | 'pen' | 'note' | 'tick' | 'cross' | 'erase' = ((): any => { try { const t = localStorage.getItem('osm-tool'); return t === 'pen' || t === 'note' || t === 'tick' || t === 'cross' || t === 'erase' ? t : 'pen'; } catch { return 'pen'; } })(); let penColor = '#d93025'; let penW = 3;
    const theme = (() => { try { return localStorage.getItem('osm-theme') || 'light'; } catch { return 'light'; } })();

    el.innerHTML = `
      <div class="osm-desk ${theme === 'dark' ? 'dark' : ''}" id="osm-desk">
        <div class="osm-desk-top">
          <button class="osm-btn ghost" id="osm-close">${ICON.back}<span>Papers</span></button>
          <div class="osm-titlebox"><div class="osm-title">${esc(doc.studentName || stu?.name || '')} <span class="osm-sub">Roll ${esc(doc.rollNumber || stu?.rollNumber || '')}</span></div><div class="osm-sub">${esc(paper.title)}</div></div>
          <div class="osm-tools">
            <button class="osm-btn small" id="osm-hist" title="Everything changed on this sheet: who, what, which question, when">${ICON.msg}<span>History</span></button>
            <span class="osm-inkstat saved" id="osm-ready" style="display:none">✔ Ready for analysis</span><span class="osm-inkstat" id="osm-ink-status" title="Every change is saved"></span>
          </div>
        </div>
        <div class="osm-desk-main">
          <div class="osm-vtools" id="osm-vtools">
            <button id="t-pen" class="vt" title="Pen (click again to stop drawing and just scroll)"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span>Pen</span></button>
            <button id="t-note" class="vt" title="Type a text note on the page"><b style="font-size:15px;line-height:20px">Aa</b><span>Note</span></button>
            <button id="t-tick" class="vt" title="Tick mark: click anywhere on the page to place it"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#1e8e4e" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg><span>Tick</span></button>
            <button id="t-cross" class="vt" title="Cross mark: click anywhere on the page to place it"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#d93025" stroke-width="3.2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg><span>Cross</span></button>
            <button id="t-erase" class="vt" title="Erase your own marks (click one)"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20H9l-5-5a2 2 0 0 1 0-2.8l9-9a2 2 0 0 1 2.8 0l5 5a2 2 0 0 1 0 2.8L12 20"/><path d="M7 11l6 6"/></svg><span>Erase</span></button>
            <i class="vsep"></i>
            <label class="vt colorlbl" title="Pen / note colour"><input type="color" id="t-color" value="${penColor}"><span>Colour</span></label>
            <div class="vw" title="Size of pen, notes and marks"><button data-w="2" class="vwb"><i style="height:2px"></i><span>Thin</span></button><button data-w="3" class="vwb on"><i style="height:4px"></i><span>Medium</span></button><button data-w="6" class="vwb"><i style="height:7px"></i><span>Thick</span></button></div>
            <i class="vsep"></i>
            <button class="vt" id="t-undo" title="Undo (Ctrl+Z)"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg><span>Undo</span></button>
            <button class="vt" id="t-theme" title="Dark / light panel">${theme === 'dark' ? '☀' : '☾'}<span>Theme</span></button>
          </div>
          <div class="osm-pages-wrap">
            <div class="osm-pages" id="osm-pages"></div>
            <div class="osm-zoombar"><button id="z-out" title="Zoom out">−</button><span id="z-val">${zoom}%</span><button id="z-in" title="Zoom in">+</button><i></i><button id="z-fit" title="Fit page to width">Fit</button><i></i><span id="z-page">Page 1 of ${doc.pages?.length || 0}</span></div>
          </div>
          <aside class="osm-side" id="osm-side"></aside>
        </div>
      </div>`;
    const desk = el.querySelector('#osm-desk') as HTMLElement;
    const pagesEl = el.querySelector('#osm-pages') as HTMLElement;
    const sideEl = el.querySelector('#osm-side') as HTMLElement;
    el.querySelector('#osm-close')!.addEventListener('click', () => openPaper(roster, paper, teachers));

    // ---- pages + ink -------------------------------------------------------
    const pageWrap: HTMLElement[] = []; const pageDims: { w: number; h: number }[] = [];
    (doc.pages || []).forEach((p, i) => {
        const w = document.createElement('div'); w.className = 'osm-page'; w.dataset.i = String(i);
        w.innerHTML = `<div class="osm-pg-label">Page ${i + 1} of ${doc.pages!.length} <span class="osm-pg-n"></span></div><div class="osm-pg-inner"><img alt="Page ${i + 1}" draggable="false"><svg class="osm-ink" xmlns="http://www.w3.org/2000/svg"></svg></div>`;
        pagesEl.appendChild(w); pageWrap.push(w);
        const img = w.querySelector('img') as HTMLImageElement;
        img.onload = () => { pageDims[i] = { w: img.naturalWidth, h: img.naturalHeight }; sizePage(i); renderInk(i); };
        img.src = p.url;
    });
    function sizePage(i: number) {
        const w = pageWrap[i]; const inner = w.querySelector('.osm-pg-inner') as HTMLElement; const d = pageDims[i]; if (!d) return;
        inner.style.width = zoom + '%';
        const svg = w.querySelector('svg') as SVGSVGElement; svg.setAttribute('viewBox', `0 0 1000 ${(1000 * d.h / d.w).toFixed(1)}`); svg.setAttribute('preserveAspectRatio', 'none');
    }
    function stampSvg(s: InkStroke, op: number, tu: string, si: number) {
        const x = Number(s.x) || 0, y = Number(s.y) || 0, z = Number(s.w) || 40;
        const d = s.k === 'tick' ? `M${x - .45 * z} ${y + .02 * z} L${x - .12 * z} ${y + .38 * z} L${x + .5 * z} ${y - .4 * z}` : `M${x - .4 * z} ${y - .4 * z} L${x + .4 * z} ${y + .4 * z} M${x + .4 * z} ${y - .4 * z} L${x - .4 * z} ${y + .4 * z}`;
        const col = s.k === 'tick' ? '#1e8e4e' : '#d93025';
        return `<path d="${d}" stroke="${col}" stroke-width="${(z * .15).toFixed(1)}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${op}" data-t="${esc(tu)}" data-s="${si}" data-k="${s.k}"/>`;
    }
    function renderInk(i: number) {
        const svg = pageWrap[i].querySelector('svg') as SVGSVGElement; if (!svg) return;
        svg.innerHTML = Object.entries(inks).map(([tu, pg]) => (pg[String(i)] || []).map((s, si) => s.k ? stampSvg(s, tu === me.uid ? 1 : 0.6, tu, si) : s.t !== undefined
             ? `<text x="${Number(s.x) || 0}" y="${Number(s.y) || 0}" fill="${esc(s.c)}" font-size="${Number(s.w) || 24}" font-weight="600" style="font-family:Poppins,system-ui,sans-serif;paint-order:stroke;stroke:#fff;stroke-width:${Math.max(3, (Number(s.w) || 24) / 6)}px;stroke-linejoin:round;white-space:pre" opacity="${tu === me.uid ? 1 : 0.6}" data-t="${esc(tu)}" data-s="${si}">${String(s.t).split('\n').map((ln, k) => `<tspan x="${Number(s.x) || 0}" dy="${k ? '1.2em' : '0'}">${esc(ln)}</tspan>`).join('')}</text>`
             : `<path d="${esc(s.d || '')}" stroke="${esc(s.c)}" stroke-width="${Number(s.w) || 3}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${tu === me.uid ? 1 : 0.55}" data-t="${esc(tu)}" data-s="${si}"/>`).join('')).join('');
        const mineN = (inks[me.uid]?.[String(i)] || []).length; const theirN = Object.entries(inks).reduce((a, [tu, pg]) => a + (tu === me.uid ? 0 : (pg[String(i)] || []).length), 0);
        const lab = pageWrap[i].querySelector('.osm-pg-n') as HTMLElement | null; if (lab) lab.textContent = (mineN || theirN) ? `· ${mineN} annotation${mineN === 1 ? '' : 's'} by you${theirN ? `, ${theirN} by co-teachers` : ''}` : '';
        svg.style.pointerEvents = tool === 'none' ? 'none' : 'auto';
        svg.style.cursor = tool === 'pen' ? 'crosshair' : tool === 'note' ? 'text' : tool === 'erase' ? 'cell' : 'default';
    }
    let inkTimer: any = null; let lastInkPage = -1;
    let inkDirty = false; let inkSaving = 0; let alive = true; let inkLoaded = false; let inkFails = 0;
    const myStrokeCount = () => Object.values(inks[me.uid] || {}).reduce((a, arr: any) => a + arr.length, 0);
    function renderSync() {
        if (!alive) return;
        const e = desk.querySelector('#osm-ink-status') as HTMLElement | null; const n = obPendingCount(); const bad = n > 0 && ob.fails > 0;
        const txt = bad ? `⚠ ${n} change${n > 1 ? 's' : ''} not saved yet — kept on this device, retrying` : (n || inkDirty) ? '⏳ Saving…' : `✓ All changes saved${myStrokeCount() ? ` · ${myStrokeCount()} annotation${myStrokeCount() > 1 ? 's' : ''}` : ''}`;
        if (e) { e.className = 'osm-inkstat ' + (bad ? 'error' : (n || inkDirty) ? 'saving' : 'saved'); e.textContent = txt; e.title = bad ? ('Reason: ' + ob.lastErr + '. Nothing is lost — it is stored on this computer and is sent automatically when the connection returns.') : 'Every mark, note, feedback edit and annotation is saved to the cloud. See History for the full log.'; }
        const t2 = bad ? 'Not saved yet — kept, retrying' : n ? 'Saving…' : 'Saved ✓'; const c2 = 'osm-save ' + (bad ? 'bad' : n ? '' : 'ok');
        [statusEl, sideEl.querySelector('#osm-save') as HTMLElement | null].forEach(x => { if (x) { x.textContent = t2; x.className = c2; } });
    }
    function setInkStatus(_kind?: string) { renderSync(); }
    const inkCounts = () => { const r: Record<string, Record<string, number>> = {}; Object.entries(inks[me.uid] || {}).forEach(([pg, arr]: any) => arr.forEach((st: any) => { const k = st.k || (st.t !== undefined ? 'note' : 'pen'); (r[pg] ||= {})[k] = (r[pg][k] || 0) + 1; })); return r; };
    let inkBase: Record<string, Record<string, number>> = {}; let inkLoadFailed = false;
    function flushInk() { if (inkDirty && inkLoaded) saveInk(); void obFlush(); }
    function saveInk() {
        inkDirty = true; renderSync();
        if (!inkLoaded) return;   // wait until your saved strokes are read, so they are never overwritten
        const cur = inkCounts(); const acc: any = {};
        new Set([...Object.keys(cur), ...Object.keys(inkBase)]).forEach(pg => ['pen', 'note', 'tick', 'cross'].forEach(k => { const dlt = (cur[pg]?.[k] || 0) - (inkBase[pg]?.[k] || 0); if (dlt) (acc[pg] ||= {})[k] = dlt; }));
        inkBase = cur; inkDirty = false;
        obEnqueue({ key: `ink:${paper.id}:${studentUid}:${me.uid}`, kind: 'ink', by: me.uid, owner: paper.owner, pid: paper.id, suid: studentUid, at: Date.now(), data: { pages: plain(inks[me.uid] || {}), pv: doc.pagesVersion ?? null, teacherName: me.name, acc, union: inkLoadFailed } }, 700);
    }
    const warnUnload = (e: BeforeUnloadEvent) => { if (alive && (inkDirty || ob.memOnly && obPendingCount())) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warnUnload);
    window.addEventListener('pagehide', flushInk);
    // undo (button and Ctrl/Cmd+Z): add / erase / edit, in the order they were done
    const undoStack: any[] = [];
    function pushStroke(i: number, st: InkStroke) { (inks[me.uid] ||= {}); const arr = (inks[me.uid][String(i)] ||= []); arr.push(st); undoStack.push({ t: 'add', p: i, s: st }); if (undoStack.length > 300) undoStack.shift(); }
    function undoLast() {
        const a = undoStack.pop(); if (!a) { toast('Nothing to undo.', 'info'); return; }
        const arr = ((inks[me.uid] ||= {})[String(a.p)] ||= []);
        if (a.t === 'add') { const ix = arr.indexOf(a.s); if (ix >= 0) arr.splice(ix, 1); }
        else if (a.t === 'del') arr.splice(Math.min(a.ix, arr.length), 0, a.s);
        else if (a.t === 'edit') { const ix = arr.indexOf(a.cur); if (ix >= 0) arr[ix] = a.prev; }
        else if (a.t === 'move') { a.s.x = a.ox; a.s.y = a.oy; }
        lastInkPage = a.p; renderInk(a.p); saveInk();
    }
    // eraser: the nearest one of YOUR marks within a generous reach is removed (no pin-pointing needed)
    function nearestOwn(i: number, p: { x: number; y: number }, reach: number): number {
        const arr = inks[me.uid]?.[String(i)] || []; let best = -1, bd = Infinity;
        arr.forEach((st: any, si: number) => {
            let d = Infinity;
            if (st.k) { const z = +st.w || 40; d = Math.max(0, Math.hypot(p.x - (+st.x || 0), p.y - (+st.y || 0)) - z * .55); }
            else if (st.t !== undefined) { const fs = +st.w || 24; const lines = String(st.t).split('\n'); const w = Math.max(...lines.map((l: string) => l.length)) * fs * .6, h = lines.length * fs * 1.2; const x0 = +st.x || 0, y0 = (+st.y || 0) - fs; const dx = Math.max(x0 - p.x, 0, p.x - (x0 + w)), dy = Math.max(y0 - p.y, 0, p.y - (y0 + h)); d = Math.hypot(dx, dy); }
            else if (st.d) { const nums = String(st.d).match(/-?\d+(?:\.\d+)?/g)?.map(Number) || []; const pts: number[][] = []; for (let k = 0; k + 1 < nums.length; k += 2) pts.push([nums[k], nums[k + 1]]);
                for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[k + 1] || a; const vx = b[0] - a[0], vy = b[1] - a[1]; const l2 = vx * vx + vy * vy; const t = l2 ? Math.max(0, Math.min(1, ((p.x - a[0]) * vx + (p.y - a[1]) * vy) / l2)) : 0; d = Math.min(d, Math.hypot(p.x - (a[0] + t * vx), p.y - (a[1] + t * vy))); } d = Math.max(0, d - (+st.w || 3) / 2); }
            if (d <= reach && d < bd) { bd = d; best = si; }
        });
        return best;
    }
    function eraseAt(i: number, p: { x: number; y: number }) {
        const ix = nearestOwn(i, p, 30); if (ix < 0) return false;
        const arr = inks[me.uid][String(i)]; const [st] = arr.splice(ix, 1); undoStack.push({ t: 'del', p: i, ix, s: st }); lastInkPage = i; renderInk(i); saveInk(); return true;
    }
    // drawing
    pagesEl.addEventListener('pointerdown', (ev: PointerEvent) => {
        if (tool === 'none') return;
        const svg = (ev.target as Element).closest('svg.osm-ink') as SVGSVGElement | null; if (!svg) return;
        const wrap = svg.closest('.osm-page') as HTMLElement; const i = Number(wrap.dataset.i);
        const vb = svg.viewBox.baseVal; const rect = svg.getBoundingClientRect();
        const pt = (e: PointerEvent) => ({ x: ((e.clientX - rect.left) / rect.width) * vb.width, y: ((e.clientY - rect.top) / rect.height) * vb.height });
        if (tool === 'erase') {
            ev.preventDefault(); eraseAt(i, pt(ev)); svg.setPointerCapture(ev.pointerId);
            const mvE = (e: PointerEvent) => { eraseAt(i, pt(e)); };   // keep the button down and sweep over marks to remove several
            const upE = () => { svg.removeEventListener('pointermove', mvE); svg.removeEventListener('pointerup', upE); svg.removeEventListener('pointercancel', upE); };
            svg.addEventListener('pointermove', mvE); svg.addEventListener('pointerup', upE); svg.addEventListener('pointercancel', upE);
            return;
        }
        if (tool === 'tick' || tool === 'cross') {
            ev.preventDefault(); const p = pt(ev); const z = penW === 2 ? 28 : penW === 3 ? 40 : 60;
            pushStroke(i, { c: tool === 'tick' ? '#1e8e4e' : '#d93025', w: z, k: tool, x: Number(p.x.toFixed(1)), y: Number(p.y.toFixed(1)) });
            lastInkPage = i; renderInk(i); saveInk(); return;
        }
        if (tool === 'note') {
            ev.preventDefault();
            const arr0 = inks[me.uid]?.[String(i)] || []; const p0 = pt(ev); const hit = nearestOwn(i, p0, 14); const idx = hit >= 0 && arr0[hit].t !== undefined ? hit : -1;
            if (idx < 0) { openNoteEditor(i, svg, null, -1, p0); return; }
            // an existing note: drag it anywhere, or just click it to edit the words
            const st: any = arr0[idx]; const ox = +st.x, oy = +st.y; let moved = false; svg.setPointerCapture(ev.pointerId);
            const mvN = (e: PointerEvent) => { const p = pt(e); if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) < 6) return; moved = true; st.x = Number((ox + p.x - p0.x).toFixed(1)); st.y = Number((oy + p.y - p0.y).toFixed(1)); renderInk(i); };
            const upN = () => { svg.removeEventListener('pointermove', mvN); svg.removeEventListener('pointerup', upN); svg.removeEventListener('pointercancel', upN);
                if (moved) { undoStack.push({ t: 'move', p: i, s: st, ox, oy }); lastInkPage = i; saveInk(); } else openNoteEditor(i, svg, st, idx, p0); };
            svg.addEventListener('pointermove', mvN); svg.addEventListener('pointerup', upN); svg.addEventListener('pointercancel', upN);
            return;
        }
        ev.preventDefault(); svg.setPointerCapture(ev.pointerId);
        const p0 = pt(ev); let d = `M${p0.x.toFixed(1)} ${p0.y.toFixed(1)}`; let last = p0;
        const live = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        live.setAttribute('stroke', penColor); live.setAttribute('stroke-width', String(penW)); live.setAttribute('fill', 'none'); live.setAttribute('stroke-linecap', 'round'); live.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(live);
        const mv = (e: PointerEvent) => { const p = pt(e); if (Math.hypot(p.x - last.x, p.y - last.y) < 1.2) return; d += ` L${p.x.toFixed(1)} ${p.y.toFixed(1)}`; last = p; live.setAttribute('d', d); };
        const up = () => {
            svg.removeEventListener('pointermove', mv); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up);
            if (d.includes('L')) { pushStroke(i, { c: penColor, w: penW, d }); lastInkPage = i; saveInk(); }
            renderInk(i);
        };
        svg.addEventListener('pointermove', mv); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
    });
    // text notes: click on the page, type, Enter to place (Shift+Enter = new line, Esc = cancel). Click one of your notes to edit it.
    function openNoteEditor(i: number, svg: SVGSVGElement, existing: InkStroke | null, idx: number, at: { x: number; y: number }) {
        pagesEl.querySelectorAll('.osm-note-edit').forEach(n => n.remove());
        const inner = svg.parentElement as HTMLElement; const vb = svg.viewBox.baseVal;
        const x = existing ? Number(existing.x) : at.x, y = existing ? Number(existing.y) : at.y;
        const fs = existing ? Number(existing.w) || 28 : (penW === 2 ? 22 : penW === 3 ? 30 : 42);
        const ta = document.createElement('textarea'); ta.className = 'osm-note-edit'; ta.rows = 1; ta.placeholder = 'Type a note…'; ta.value = existing?.t || '';
        // compact box that always stays inside the page (never runs off the edge), grows a little, then scrolls inside itself
        const pw = inner.clientWidth, ph = inner.clientHeight; const bw = Math.max(130, Math.min(230, pw - 12)); const lx = Math.max(4, Math.min(x / vb.width * pw, pw - bw - 4)); const ty = Math.max(4, Math.min((y - fs) / vb.height * ph, ph - 70));
        ta.style.cssText = `left:${lx.toFixed(0)}px;top:${ty.toFixed(0)}px;width:${bw}px;color:${existing?.c || penColor};font-size:${Math.max(13, Math.min(17, fs / vb.width * pw)).toFixed(0)}px`;
        inner.appendChild(ta); ta.focus(); ta.select();
        let done = false;
        const commit = (save: boolean) => {
            if (done) return; done = true; const txt = ta.value.replace(/\s+$/, ''); ta.remove();
            if (!save) return;
            const arr = ((inks[me.uid] ||= {})[String(i)] ||= []);
            if (!txt) { if (idx >= 0) { const [old] = arr.splice(idx, 1); undoStack.push({ t: 'del', p: i, ix: idx, s: old }); } }
            else if (idx >= 0) { const prev = arr[idx]; const cur = { ...prev, t: txt }; arr[idx] = cur; undoStack.push({ t: 'edit', p: i, cur, prev }); }
            else pushStroke(i, { c: penColor, w: fs, t: txt, x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) });
            lastInkPage = i; renderInk(i); saveInk();
        };
        ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(true); } else if (e.key === 'Escape') { e.preventDefault(); commit(false); } });
        ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(110, ta.scrollHeight + 2) + 'px'; });
        ta.addEventListener('blur', () => commit(true));
    }
    // load existing ink (all teachers); live-updates
    (async () => {
        try {
            const snap = await paperRef(paper.owner, paper.id).collection('submissions').doc(studentUid).collection('detail').get();
            snap.docs.forEach((d: any) => { if (d.id.startsWith('osmInk_')) { if ((d.data().pv ?? null) !== (doc.pagesVersion ?? null)) return; const tu = d.id.slice(7); if (tu === me.uid && inks[me.uid]) { Object.entries(d.data().pages || {}).forEach(([pg, arr]: any) => { const cur = (inks[me.uid][pg] ||= []); if (!cur.length) inks[me.uid][pg] = arr; else inks[me.uid][pg] = [...arr, ...cur.filter((c: any) => !arr.some((a: any) => JSON.stringify(a) === JSON.stringify(c)))]; }); } else inks[tu] = d.data().pages || {}; } });
            pageWrap.forEach((_, i) => renderInk(i)); inkLoaded = true; inkBase = inkCounts(); renderSync();
            if (inkDirty) saveInk();
        } catch (e) { console.warn('[osm] ink load', e); inkLoaded = true; inkLoadFailed = true; inkBase = inkCounts(); toast('Could not load existing pen marks — new marks will still be saved safely.', 'info'); if (inkDirty) saveInk(); }
    })();

    // co-teachers' pen marks, ticks and notes appear live (no refresh needed); yours are never replaced by this
    { const un = paperRef(paper.owner, paper.id).collection('submissions').doc(studentUid).collection('detail').onSnapshot((snap: any) => {
        let any = false;
        snap.docChanges().forEach((ch: any) => { const id: string = ch.doc.id; if (!id.startsWith('osmInk_') || ch.type === 'removed') return; const tu = id.slice(7); if (tu === me.uid) return; const d = ch.doc.data(); if ((d.pv ?? null) !== (doc.pagesVersion ?? null)) return; inks[tu] = d.pages || {}; any = true; });
        if (any) pageWrap.forEach((_, i) => renderInk(i));
      }, (e: any) => console.warn('[osm] live ink listener', e)); stopListeners.push(un); }

    // ---- tool buttons ------------------------------------------------------
    const TOOLS = ['pen', 'note', 'tick', 'cross', 'erase'] as const;
    const setTool = (t: typeof tool) => {
        tool = t; try { localStorage.setItem('osm-tool', t); } catch { /* */ }
        TOOLS.forEach(k => el.querySelector('#t-' + k)!.classList.toggle('on', k === t));
        pageWrap.forEach((_, i) => renderInk(i));
    };
    setTool(tool);
    // clicking the active tool again switches drawing off so the sheet can simply be scrolled
    TOOLS.forEach(k => el.querySelector('#t-' + k)!.addEventListener('click', () => setTool(tool === k ? 'none' : k)));
    (el.querySelector('#t-color') as HTMLInputElement).addEventListener('input', e => { penColor = (e.target as HTMLInputElement).value; });
    el.querySelectorAll('.vwb').forEach(b => b.addEventListener('click', () => { penW = Number((b as HTMLElement).dataset.w); el.querySelectorAll('.vwb').forEach(o => o.classList.toggle('on', o === b)); }));
    el.querySelector('#t-undo')!.addEventListener('click', () => undoLast());
    const onKeyUndo = (e: KeyboardEvent) => {
        if (!alive || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
        const t = e.target as HTMLElement | null; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;   // inside a text box, Ctrl+Z keeps undoing typing
        e.preventDefault(); undoLast();
    };
    document.addEventListener('keydown', onKeyUndo); stopListeners.push(() => document.removeEventListener('keydown', onKeyUndo));
    const setZoom = (z: number) => { zoom = Math.max(40, Math.min(300, z)); (el.querySelector('#z-val') as HTMLElement).textContent = zoom + '%'; try { localStorage.setItem('osm-zoom', String(zoom)); } catch { /* */ } pageWrap.forEach((_, i) => sizePage(i)); };
    el.querySelector('#z-in')!.addEventListener('click', () => setZoom(zoom + 10));
    el.querySelector('#z-out')!.addEventListener('click', () => setZoom(zoom - 10));
    el.querySelector('#z-fit')!.addEventListener('click', () => setZoom(100));
    const pageInd = el.querySelector('#z-page') as HTMLElement;
    pagesEl.addEventListener('scroll', () => {
        const mid = pagesEl.getBoundingClientRect().top + pagesEl.clientHeight / 3; let cur = 0;
        pageWrap.forEach((w, i) => { if (w.getBoundingClientRect().top <= mid) cur = i; });
        pageInd.textContent = `Page ${cur + 1} of ${pageWrap.length}`;
    }, { passive: true });
    el.querySelector('#t-theme')!.addEventListener('click', () => { const dk = desk.classList.toggle('dark'); try { localStorage.setItem('osm-theme', dk ? 'dark' : 'light'); } catch { /* */ } ((el.querySelector('#t-theme') as HTMLElement).firstChild as Text).textContent = dk ? '☀' : '☾'; });

    // ---- marks panel -------------------------------------------------------
    const saveTimers: Record<number, any> = {}; const pendingRun: Record<number, () => void> = {};
    function flushMarks() { return obFlush(); }
    let savingCount = 0; let statusEl: HTMLElement | null = null;
    const setStatus = (t: string, cls = '') => { if (statusEl) { statusEl.textContent = t; statusEl.className = 'osm-save ' + cls; } };
    function chipValues(max: number): number[] {
        if (!(max > 0)) return [];
        const step = max <= 10 ? 0.5 : 1; const out: number[] = [];
        for (let v = 0; v <= max + 1e-9; v += step) out.push(Math.round(v * 2) / 2);
        return out.length <= 41 ? out : [];
    }
    function editable(i: number) { return unlockAll || myIdx.has(i); }
    // ═════════ Feedback tab: exactly what the student will see; everything is editable and autosaved ═════════
    const linesOf = (a: any) => (Array.isArray(a) ? a : []).map((x: any) => typeof x === 'string' ? x : (x?.text || '')).join('\n');
    const fbStatus = (_t?: string, _c?: string) => { renderSync(); };
    function queueReportSave(i: number) {
        const qr = fbReport?.[i]; if (!qr) return;
        obEnqueue({ key: `fb:${paper.id}:${studentUid}`, kind: 'fb', by: me.uid, owner: paper.owner, pid: paper.id, suid: studentUid, at: Date.now(), data: { items: { [String(qr.questionNumber)]: { obj: plain(qr), label: 'Q' + qr.questionNumber } } } }, 800);
    }
    function queueOverallSave() {
        if (!fbParent) return;
        obEnqueue({ key: `fbov:${paper.id}:${studentUid}`, kind: 'fbov', by: me.uid, owner: paper.owner, pid: paper.id, suid: studentUid, at: Date.now(), data: { fields: plain({ overallFeedback: fbParent.overallFeedback || {}, analysis: fbParent.analysis || {} }) } }, 800);
    }
    async function flushFb() { await obFlush(); }
    // a mark changed (here or in the Marking tab): update the report; declared total + OR rule decide the score
    function applyMarkToReport(i: number, v: number) {
        if (!fbReport || !fbReport[i] || !fbParent) return;
        fbReport[i].marksAwarded = v;
        { const na = !!doc.marks?.[qk(i)]?.na; if (na) { fbReport[i]._unattemptedAlt = true; fbReport[i]._teacherNA = true; } else if (fbReport[i]._teacherNA) { fbReport[i]._unattemptedAlt = false; delete fbReport[i]._teacherNA; } }
        const items = fbReport.map(r => ({ questionNumber: r.questionNumber, marksAwarded: r.marksAwarded || 0, maxMarksForQuestion: r.maxMarksForQuestion, checkingInstructions: r.checkingInstructions || '' }));
        let losers: Set<string>; try { losers = B.orLosers(items, paper.questions); } catch { losers = new Set(); }
        fbReport.forEach(r => { r._runtimeOrLoser = losers.has(r.questionNumber) || !!r._unattemptedAlt; });   // an alternative the student did not choose stays uncounted
        fbParent.overallScore = fbReport.filter(r => !r._runtimeOrLoser).reduce((a, r) => a + (r.marksAwarded || 0), 0);
        queueReportSave(i);
    }
    function tabsHtml() {
        if (!fbReport) return '';
        return `<div class="osm-tabs"><button data-view="mark" class="${view === 'mark' ? 'on' : ''}">${ICON.pen}<span>Marking</span></button><button data-view="fb" class="${view === 'fb' ? 'on' : ''}">${ICON.msg}<span>Feedback</span></button></div>${view === 'mark' ? '<div class="osm-sub osm-pad">This sheet is already analysed. A mark changed here also updates the report.</div>' : ''}`;
    }
    function wireTabs() {
        sideEl.querySelectorAll<HTMLButtonElement>('.osm-tabs button').forEach(b => b.addEventListener('click', async () => { await flushMarks(); await flushFb(); view = b.dataset.view as any; renderSide(); }));
    }
    // a question's feedback has three parts; reports written before this change only have the combined text
    function fbParts(qr: any) {
        let why = qr.whyLost, how = qr.howToImprove, note = qr.teacherNote;
        if (why === undefined && how === undefined) {
            const t = String(qr.finalFeedback || ''); const mm = t.match(/Where marks were lost:\s*([\s\S]*?)(?:\n\nHow to improve:|$)/); const hh = t.match(/How to improve:\s*([\s\S]*)$/); const nn = t.match(/^Teacher's note:\s*([\s\S]*?)(?:\n\n|$)/);
            note = nn ? nn[1] : ''; why = mm ? mm[1].trim() : (t && !nn ? t : ''); how = hh ? hh[1].trim() : '';
        }
        return { why: why || '', how: how || '', note: note || '' };
    }
    function composeFb(qr: any, why: string, how: string, note: string) {
        qr.whyLost = why; qr.howToImprove = how; qr.teacherNote = note;
        qr.finalFeedback = [note ? `Teacher's note: ${note}` : '', qr.headline || '', why ? `Where marks were lost: ${why}` : '', how ? `How to improve: ${how}` : ''].filter(Boolean).join('\n\n');
        const t = [note ? `Teacher's note: ${note}` : '', why, how].filter(Boolean).join(' ').trim();   // the student's marker note beside the sheet carries the same text
        if (t) { if (qr.stepWiseEvaluation?.length) qr.stepWiseEvaluation[0].comment = t; else qr.stepWiseEvaluation = [{ pageIndex: (qr.answerPageIndex >= 0 ? qr.answerPageIndex + 1 : 1), stepPoint: [], marks: (Number(qr.marksAwarded) || 0) >= (Number(qr.maxMarksForQuestion) || 0) ? (Number(qr.marksAwarded) || 0) : 0, comment: t }]; } else qr.stepWiseEvaluation = [];
    }
    const editBtn = (has: boolean) => has ? `${ICON.edit}<span>Edit</span>` : `${ICON.plus}<span>Add feedback</span>`;
    const doneBtn = `${ICON.check}<span>Done</span>`;
    // (answer key now rendered with MathJax)
    const _unusedPlainKey = (t: any) => String(t ?? '').replace(/\\\(|\\\)|\\\[|\\\]/g, '').replace(/\\text\{([^}]*)\}/g, '$1').replace(/\\d?frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)').replace(/\\times/g, '×').replace(/\\([a-zA-Z]+)/g, '$1').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    const rbox = (cls: string, label: string, text: string) => text ? `<div class="osm-rbox ${cls}"><div class="osm-rlab">${label}</div><div>${esc(text).replace(/\n/g, '<br>')}</div></div>` : '';
    function fbView(qr: any) {
        const { why, how, note } = fbParts(qr); const full = (Number(qr.marksAwarded) || 0) >= (Number(qr.maxMarksForQuestion) || 0);
        const wh = (why || how) ? `<div class="osm-rbox blue">${why ? `<div class="osm-rlab">WHERE YOU LOST MARKS</div><div>${esc(why).replace(/\n/g, '<br>')}</div>` : ''}${how ? `<div class="osm-rlab" style="margin-top:${why ? 7 : 0}px">HOW TO IMPROVE</div><div>${esc(how).replace(/\n/g, '<br>')}</div>` : ''}</div>` : '';
        return rbox('amber', "TEACHER'S NOTE", note) + wh + ((!note && !why && !how && !full) ? '<div class="osm-muted" style="font-size:.8rem">No feedback written yet.</div>' : '');
    }
    function fbCard(qr: any, i: number) {
        const q = paper.questions[i] || {}; const loser = !!qr._runtimeOrLoser; const max = qMax(q); const got = Number(qr.marksAwarded) || 0; const { why, how, note } = fbParts(qr);
        const tone = loser ? 'gray' : got >= max ? 'full' : got > 0 ? 'part' : 'zero';
        const compact = tone === 'full' && !note && !why && !how;
        return `<div class="osm-rq ${tone}${compact ? ' compact' : ''}" data-i="${i}">
          <div class="osm-rq-h"><span class="osm-rq-n">Q${esc(qr.questionNumber)}</span>${compact ? '<span class="osm-ok">✓ Full marks</span>' : ''}${loser ? '<span class="osm-tag">alternative · not counted</span>' : ''}${loser ? '' : `<span class="osm-rq-chip"><input class="osm-fbmark" data-i="${i}" value="${fmt1(got)}" inputmode="decimal"> / ${fmt1(max)}</span>`}</div>
          ${loser ? '' : `<div class="osm-rq-view" data-i="${i}">${fbView(qr)}</div>
            <div class="osm-rq-edit" data-i="${i}" style="display:none">
              <label>Teacher's note <small>(optional)</small></label><textarea class="osm-fbta" data-f="note" data-i="${i}" rows="2">${esc(note)}</textarea>
              <label>Where you lost marks</label><textarea class="osm-fbta" data-f="why" data-i="${i}" rows="4">${esc(why)}</textarea>
              <label>How to improve</label><textarea class="osm-fbta" data-f="how" data-i="${i}" rows="3">${esc(how)}</textarea></div>
            <div class="osm-rq-foot"><button class="osm-btn tiny osm-fbedit" data-i="${i}">${editBtn(!!(why || how || note))}</button>${q.answer ? `<details class="osm-sol"><summary>Answer key</summary><div class="osm-keymath">${B.fmtMath(esc(q.answer))}</div></details>` : ''}</div>`}
        </div>`;
    }
    let curL = computeLearn([]);   // topic-by-topic results, recomputed from the marks every time the Feedback tab is drawn
    function ovView(k: string, text: string) {
        const items = text.split('\n').map(x => x.trim()).filter(Boolean);
        if (!items.length) return '<span class="osm-muted">—</span>';
        if (k === 'summary') return esc(text).replace(/\n/g, '<br>');
        if (k === 'steps') return learnBlocks(curL, { fs: 12, steps: items }).filter(b => b.kind === 'step').map(b => b.html).join('');
        return items.map(t => `<span class="osm-pill ${k === 'strengths' ? 'g' : 'a'}">${esc(t.replace(/^\[([^\]]+)\].*$/, '$1'))}</span>`).join('');
    }
    function ovBlock(k: string, label: string, text: string, list: boolean) {
        return `<div class="osm-ovb"><div class="osm-ovh"><b>${label}</b><button class="osm-btn tiny osm-ovedit" data-k="${k}">${editBtn(true)}</button></div><div class="osm-ovtext" data-k="${k}">${ovView(k, text)}</div><textarea class="osm-ovta" data-k="${k}" rows="${list ? 6 : 4}" style="display:none">${esc(text)}</textarea></div>`;
    }
    function bars(rows: { label: string; val: string; pct: number; col: string }[]) {
        return `<div class="osm-bars">${rows.map(r => `<div class="osm-bar2"><span class="osm-bl">${esc(r.label)}</span><span class="osm-bt"><i style="width:${Math.max(0, Math.min(100, r.pct))}%;background:${r.col}"></i></span><b style="color:${r.col}">${esc(r.val)}</b></div>`).join('')}</div>`;
    }
    function renderFb() {
        if (!fbReport || !fbParent) return;
        const prev = (sideEl.querySelector('#osm-fbs') as HTMLElement | null)?.scrollTop ?? 0;
        const dt = declaredTotal(paper); const score = Number(fbParent.overallScore) || 0; const pctv = dt ? Math.round(score / dt * 100) : 0; const pub = !!fbParent.published;
        const of = fbParent.overallFeedback || {}; const an = fbParent.analysis || {};
        const cm: any[] = of.conceptMastery || an.conceptMastery || []; const flags: any[] = an.flags || []; const lb: any[] = an.lostByMode || [];
        const win = an.marksToWinBack ?? Math.max(0, dt - score); const gr = pctv >= 90 ? 'A+' : pctv >= 80 ? 'A' : pctv >= 70 ? 'B+' : pctv >= 60 ? 'B' : pctv >= 50 ? 'C' : 'D';
        const col = (p: number) => p >= 80 ? '#1e8e4e' : p >= 50 ? '#d17a0a' : '#d12f3a';
        const nLost = fbReport.filter(r => !r._runtimeOrLoser && (Number(r.marksAwarded) || 0) < (Number(r.maxMarksForQuestion) || 0)).length; const nAll = fbReport.filter(r => !r._runtimeOrLoser).length;
        curL = computeLearn(fbReport);
        const toneOf = (r: any) => r._runtimeOrLoser ? 'gray' : (Number(r.marksAwarded) || 0) >= (Number(r.maxMarksForQuestion) || 0) ? 'full' : (Number(r.marksAwarded) || 0) > 0 ? 'part' : 'zero';
        sideEl.innerHTML = `${tabsHtml()}
          <div class="osm-fbhead">
            <div class="osm-fbtop"><div class="osm-fbscore"><span class="osm-fbbig">${fmt1(score)}</span><span class="osm-fbof">/ ${dt || '—'}</span></div><span class="osm-grade" style="background:${col(pctv)}">${pctv}% · Grade ${gr}</span></div>
            <div class="osm-fbstat"><span class="osm-badge ${pub ? 'published' : 'analysed'}"><i></i>${pub ? 'Published' : 'Analysed · ready to publish'}</span><span id="osm-save" class="osm-save"></span></div>
            <div class="osm-fbacts"><button class="osm-btn primary" id="fb-publish">${ICON.send}<span>${pub ? 'Re-publish' : 'Publish'}</span></button><button class="osm-btn" id="fb-pdf">${ICON.file}<span>Analysis PDF</span></button>${pub ? `<button class="osm-btn quiet" id="fb-unpublish">${ICON.eyeoff}<span>Unpublish</span></button>` : ''}</div>
            ${pub ? '<div class="osm-hint">Edits are saved here. Click Re-publish to update the student’s copy.</div>' : ''}
          </div>
          <div class="osm-fbbar"><div class="osm-seg2"><button class="on" data-fl="lost">Lost marks <b>${nLost}</b></button><button data-fl="all">All questions <b>${nAll}</b></button></div></div>
          <div class="osm-fbscroll" id="osm-fbs" data-f="lost">
            <div class="osm-qmap" title="Jump to a question">${fbReport.map((r, i) => `<button class="osm-qm ${toneOf(r)}" data-i="${i}">${esc(r.questionNumber)}</button>`).join('')}</div>
            ${fbReport.map((qr, i) => fbCard(qr, i)).join('')}
            <div class="osm-ov"><div class="osm-ovtitle">Learning summary</div>
              ${learnBlocks(curL, { fs: 12 }).filter(x => x.kind !== 'summary').map(x => x.html).join('')}
              ${ovBlock('steps', 'Your next steps', linesOf(of.nextSteps), true)}
              ${flags.length ? `<div class="osm-flags"><b>For you only (the student does not see this)</b><ul>${flags.map(f => `<li>Q${esc(f.q)}: ${esc(f.text)}</li>`).join('')}</ul></div>` : ''}
            </div>
          </div>
          <div class="osm-foot"><div class="osm-actions"><span style="flex:1"></span><button class="osm-btn small" id="osm-next" ${pos >= 0 && pos < order.length - 1 ? '' : 'disabled'} title="${pos >= 0 && pos < order.length - 1 ? 'Go to the next student on the list (A–Z) who has an answer sheet. You do not need to finish this one.' : 'No further student with an uploaded answer sheet. Upload more sheets on the paper page.'}"><span>Next student</span>${ICON.next}</button></div></div>`;
        // filter (lost marks / all) and the question map
        const fbs = sideEl.querySelector('#osm-fbs') as HTMLElement;
        sideEl.querySelectorAll<HTMLButtonElement>('.osm-seg2 button').forEach(b2 => b2.addEventListener('click', () => { fbs.dataset.f = b2.dataset.fl!; sideEl.querySelectorAll('.osm-seg2 button').forEach(x => x.classList.toggle('on', x === b2)); fbs.scrollTop = 0; }));
        sideEl.querySelectorAll<HTMLButtonElement>('.osm-qm').forEach(b2 => b2.addEventListener('click', () => {
            const card2 = sideEl.querySelector(`.osm-rq[data-i="${b2.dataset.i}"]`) as HTMLElement | null; if (!card2) return;
            if (getComputedStyle(card2).display === 'none') { fbs.dataset.f = 'all'; sideEl.querySelectorAll('.osm-seg2 button').forEach(x => x.classList.toggle('on', (x as HTMLElement).dataset.fl === 'all')); }
            fbs.scrollTo({ top: card2.offsetTop - fbs.offsetTop - 6, behavior: 'smooth' }); card2.classList.add('flash'); setTimeout(() => card2.classList.remove('flash'), 1200);
        }));
        (sideEl.querySelector('#osm-fbs') as HTMLElement).scrollTop = prev;
        try { B.typeset(sideEl.querySelector('#osm-fbs') as HTMLElement); } catch { /* math stays readable */ }
        wireTabs();
        sideEl.querySelector('#osm-next')?.addEventListener('click', async () => { await flushFb(); pos < order.length - 1 && openDesk(roster, paper, teachers, order[pos + 1], order, view); });
        // per-question feedback: ✎ Edit opens the three boxes; typing saves by itself
        sideEl.querySelectorAll<HTMLButtonElement>('.osm-fbedit').forEach(b => b.addEventListener('click', () => {
            const i = Number(b.dataset.i); const ed = sideEl.querySelector(`.osm-rq-edit[data-i="${i}"]`) as HTMLElement; const vw = sideEl.querySelector(`.osm-rq-view[data-i="${i}"]`) as HTMLElement;
            if (ed.style.display === 'none') { ed.style.display = 'block'; vw.style.display = 'none'; b.innerHTML = doneBtn; (ed.querySelector('textarea[data-f="why"]') as HTMLTextAreaElement).focus(); }
            else { const p = fbParts(fbReport![i]); if (!(p.why || p.how || p.note)) { renderFb(); return; } ed.style.display = 'none'; vw.style.display = 'block'; vw.innerHTML = fbView(fbReport![i]); b.innerHTML = editBtn(true); }
        }));
        sideEl.querySelectorAll<HTMLTextAreaElement>('.osm-fbta').forEach(ta => ta.addEventListener('input', () => {
            const i = Number(ta.dataset.i); const ed = sideEl.querySelector(`.osm-rq-edit[data-i="${i}"]`)!; const g = (f: string) => (ed.querySelector(`textarea[data-f="${f}"]`) as HTMLTextAreaElement).value.trim();
            composeFb(fbReport![i], g('why'), g('how'), g('note')); queueReportSave(i);
        }));
        sideEl.querySelectorAll<HTMLInputElement>('.osm-fbmark').forEach(inp => {
            inp.addEventListener('focus', () => inp.select());
            inp.addEventListener('change', async () => {
                const i = Number(inp.dataset.i); const max = qMax(paper.questions[i]);
                let v = Math.round(parseFloat(inp.value.replace(',', '.')) * 2) / 2; if (isNaN(v) || v < 0) v = 0; if (max > 0 && v > max) { v = max; toast(`Out of ${fmt1(max)} — set to ${fmt1(max)}.`, 'info'); }
                queueSave(i, String(v), inp, true); renderFb();
            });
        });
        // overall analysis blocks
        sideEl.querySelectorAll<HTMLButtonElement>('.osm-ovedit').forEach(b => b.addEventListener('click', () => {
            const k = b.dataset.k!; const ta = sideEl.querySelector(`.osm-ovta[data-k="${k}"]`) as HTMLTextAreaElement; const tx = sideEl.querySelector(`.osm-ovtext[data-k="${k}"]`) as HTMLElement;
            if (ta.style.display === 'none') { ta.style.display = 'block'; tx.style.display = 'none'; b.innerHTML = doneBtn; ta.focus(); }
            else { ta.style.display = 'none'; tx.style.display = 'block'; b.innerHTML = editBtn(true); tx.innerHTML = ovView(k, ta.value); }
        }));
        sideEl.querySelectorAll<HTMLTextAreaElement>('.osm-ovta').forEach(ta => ta.addEventListener('input', () => {
            const k = ta.dataset.k!; const split = (t: string) => t.split('\n').map(x => x.trim()).filter(Boolean); const o = (fbParent.overallFeedback ||= {});
            if (k === 'summary') o.summary = ta.value.trim(); else if (k === 'strengths') o.strengths = split(ta.value); else if (k === 'areas') o.areasForImprovement = split(ta.value); else if (k === 'steps') o.nextSteps = split(ta.value);
            fbParent.analysis = { ...(fbParent.analysis || {}), edited: true, editedAt: new Date().toISOString(), editedBy: me.name };
            queueOverallSave();
        }));
        sideEl.querySelector('#fb-publish')?.addEventListener('click', async () => {
            if (!confirm(`${pub ? 'Re-publish' : 'Publish'} this report to the student? They will see the marks and feedback in their app.`)) return;
            busy(true, 'Publishing…'); try { await flushFb(); await publishOne(paper, studentUid); fbParent.published = true; toast('Published.', 'success'); renderFb(); } catch (e: any) { toast('Could not publish: ' + e.message, 'error'); } finally { busy(false); }
        });
        sideEl.querySelector('#fb-unpublish')?.addEventListener('click', async () => {
            if (!confirm('Unpublish this report? The student will no longer see it. Nothing is deleted.')) return;
            busy(true, 'Unpublishing…'); try { await unpublishOne(paper, studentUid); fbParent.published = false; toast('Unpublished.', 'info'); renderFb(); } catch (e: any) { toast('Could not unpublish: ' + e.message, 'error'); } finally { busy(false); }
        });
        sideEl.querySelector('#fb-pdf')?.addEventListener('click', async () => {
            await flushFb(); busy(true, 'Preparing PDF…');
            try { await B.analysisPdf({ ...fbParent, questionWiseReport: fbReport, studentName: doc.studentName || stu?.name || '', rollNumber: doc.rollNumber || stu?.rollNumber || '' }, { assessmentTitle: paper.title, className: paper.className, section: paper.section, subject: paper.subject, ink: inks }, (t: string) => busy(true, t)); }
            catch (e: any) { toast('Could not create the PDF: ' + e.message, 'error'); } finally { busy(false); }
        });
    }
    function renderSide() {
        if (view === 'fb' && fbReport) { renderFb(); return; }
        const prevScroll = (sideEl.querySelector('#osm-qs') as HTMLElement | null)?.scrollTop ?? 0; const prevRail = (sideEl.querySelector('#osm-rail') as HTMLElement | null)?.scrollTop ?? 0;
        const openDet = new Set(Array.from(sideEl.querySelectorAll<HTMLDetailsElement>('.osm-q')).filter(r => (r.querySelector('details') as HTMLDetailsElement | null)?.open).map(r => r.dataset.i));
        renderSideInner();
        const qs = sideEl.querySelector('#osm-qs') as HTMLElement | null; if (qs) qs.scrollTop = prevScroll; const rl = sideEl.querySelector('#osm-rail') as HTMLElement | null; if (rl) rl.scrollTop = prevRail;
        openDet.forEach(i => { const d = sideEl.querySelector(`.osm-q[data-i="${i}"] details`) as HTMLDetailsElement | null; if (d) d.open = true; });
    }
    function renderSideInner() {
        const sc = scoreFor(paper, doc.marks);
        const st = studentState(paper, doc, meta, teachers);
        { const rp = desk.querySelector('#osm-ready') as HTMLElement | null; if (rp) rp.style.display = st.ready ? '' : 'none'; }
        const iAmDone = !!doc.done?.[me.uid];
        const dt = declaredTotal(paper);
        sideEl.innerHTML = `${tabsHtml()}
          <div class="osm-score"><div class="osm-score-top"><div class="osm-score-num">${fmt1(sc.total)}<small> / ${dt || '—'}</small></div>
            <div class="osm-sub"><span id="osm-marked">${sc.marked}/${sc.count}</span> marked · <span id="osm-save" class="osm-save"></span></div></div>
            <div class="osm-bar"><i style="width:${dt ? Math.min(100, sc.total / dt * 100) : 0}%"></i></div>
            ${showMine ? `<div class="osm-mine" id="osm-mine"></div>` : ''}${multiT && !hasAssign ? `<div class="osm-pickbanner" style="margin:6px 0 0">Choose your questions first: go back to the paper and press <b>Choose my questions</b>.</div>` : ''}</div>
          ${showMine ? `<label class="osm-unlock"><input type="checkbox" id="osm-unlock" ${unlockAll ? 'checked' : ''}> Also let me edit other teachers' questions</label>` : ''}
          <div class="osm-qwrap">
          <nav class="osm-rail" id="osm-rail" title="Jump to a question">${paper.questions.map((q, i) => { const m = doc.marks?.[qk(i)]; return `<button class="osm-rb ${m ? 'has' : ''} ${m?.na ? 'na' : ''} ${showMine ? (myIdx.has(i) ? 'mine' : 'notmine') : ''}" data-i="${i}" style="--c:${qColor(m, qMax(q))}">${esc(q.questionNumber || i + 1)}</button>`; }).join('')}</nav>
          <div class="osm-qs" id="osm-qs">
          ${paper.questions.map((q, i) => {
              const m = doc.marks?.[qk(i)]; const mine = editable(i); const loser = sc.losers.has(q.questionNumber || String(i + 1));
              const max = qMax(q);
              return `<div class="osm-q ${mine ? 'mine' : 'other'} ${m ? 'has' : ''} ${m?.na ? 'na' : ''} ${loser ? 'loser' : ''}" data-i="${i}" style="--c:${qColor(m, max)}">
                <div class="osm-q-row osm-qtop">
                  <div class="osm-qh"><span class="osm-qn">Q${esc(q.questionNumber || i + 1)}</span><span class="osm-max">/ ${fmt1(max)}</span>${/alternative question \(or\)/i.test(q.checkingInstructions || '') ? '<span class="osm-tag">OR</span>' : ''}${multiT ? teachers.filter(t => (meta.assign?.[t.uid] || []).includes(i)).map(t => t.uid === me.uid ? `<span class="osm-tag mine">${esc(shortName(t.name, teachers))} · yours</span>` : `<span class="osm-tag owner">${esc(shortName(t.name, teachers))}</span>`).join('') : ''}</div>
                  <button class="osm-mini osm-nab ${m?.na ? 'on' : ''}" data-i="${i}" ${mine ? '' : 'disabled'} title="Click if the student did not attempt this question (no marks, not counted as a weakness). Click again to undo.">Not attempted</button>
                </div>
                <div class="osm-q-row osm-qstep">
                  <button class="osm-mini step" data-act="dec" ${mine ? '' : 'disabled'} title="− 0.5">−</button>
                  <input class="osm-in" type="text" inputmode="decimal" autocomplete="off" value="${m && !m.na ? esc(Number(m.v)) : ''}" placeholder="–" ${mine ? '' : 'disabled'} data-i="${i}">
                  <button class="osm-mini step" data-act="inc" ${mine ? '' : 'disabled'} title="+ 0.5">+</button>
                  <button class="osm-mini full" data-act="full" ${mine ? '' : 'disabled'} title="Give full marks">Full marks</button>
                </div>
                <div class="osm-chips osm-chiprow">${chipValues(max).map(v => `<button class="osm-cv ${m && !m.na && m.v === v ? 'sel' : ''}" data-v="${v}" style="--c:${chipColor(v, max)}" ${mine ? '' : 'disabled'}>${fmt1(v)}</button>`).join('')}
                  ${m && m.by !== me.uid ? `<span class="osm-by">marked by ${esc(m.n || nameOf(m.by))}</span>` : ''}
                  <button class="osm-rbtn ${doc.notes?.[qk(i)]?.t ? 'has' : ''}" data-i="${i}" title="Write or speak why marks were cut on this question" ${mine ? '' : 'disabled'}>${ICON.pen}<span>Why marks cut?</span></button>
                </div>
                <div class="osm-reasonbox" style="display:${doc.notes?.[qk(i)]?.t ? 'block' : 'none'}"><textarea class="osm-reason" data-i="${i}" rows="3" placeholder="Why were marks cut on this question? Write or speak…" ${mine ? '' : 'disabled'}>${esc(doc.notes?.[qk(i)]?.t || '')}</textarea></div>
                <details class="osm-det"><summary>Question &amp; model answer</summary><div class="osm-qtext">${B.fmtMath(esc(q.text || ''))}</div>${q.answer ? `<div class="osm-ans"><b>Answer:</b> ${B.fmtMath(esc(q.answer))}</div>` : ''}${q.checkingInstructions ? `<div class="osm-ci">${esc(q.checkingInstructions)}</div>` : ''}</details>
                ${loser ? '<div class="osm-by">alternative not counted (other option scored higher)</div>' : ''}
              </div>`;
          }).join('')}
          </div></div>
          <div class="osm-foot">
            <div class="osm-orwarn" id="osm-orwarn" style="display:none"></div>
            <div class="osm-doneline">${paper.questions.length ? teachers.map(t => `<span class="osm-chip ${doc.done?.[t.uid] ? 'on' : ''}">${esc(shortName(t.name, teachers))}${doc.done?.[t.uid] ? ' ✓' : ''}</span>`).join('') : ''}</div>
            <div class="osm-actions"><button class="osm-btn ${iAmDone ? 'done' : 'primary'}" id="osm-given" title="${iAmDone ? 'Click to reopen and edit' : 'Click when you have finished marking this sheet'}">${iAmDone ? '✓ Completed' : 'Completed'}</button><button class="osm-btn small" id="osm-next" ${pos >= 0 && pos < order.length - 1 ? '' : 'disabled'}><span>Next student</span>${ICON.next}</button></div>
          </div>`;
        statusEl = sideEl.querySelector('#osm-save'); updateOrWarn();
        B.typeset(sideEl);
        wireSide();
    }
    function wireSide() {
        wireTabs();
        sideEl.querySelector('#osm-unlock')?.addEventListener('change', e => { unlockAll = (e.target as HTMLInputElement).checked; renderSide(); });
        sideEl.querySelectorAll<HTMLButtonElement>('.osm-rb').forEach(b => b.addEventListener('click', () => {
            const row = sideEl.querySelector(`.osm-q[data-i="${b.dataset.i}"]`) as HTMLElement | null; const qs = sideEl.querySelector('#osm-qs') as HTMLElement | null; if (!row || !qs) return;
            qs.scrollTo({ top: row.offsetTop - qs.offsetTop - 4, behavior: 'smooth' });
            row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1200);
            const inp = row.querySelector('.osm-in') as HTMLInputElement | null; if (inp && !inp.disabled) setTimeout(() => { inp.focus({ preventScroll: true }); inp.select(); }, 250);
        }));
        const inputs = Array.from(sideEl.querySelectorAll<HTMLInputElement>('.osm-in'));
        inputs.forEach(inp => {
            const i = Number(inp.dataset.i);
            inp.addEventListener('input', () => { queueSave(i, inp.value, inp); });
            inp.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); const nxt = inputs.slice(inputs.indexOf(inp) + 1).find(x => !x.disabled); if (nxt) { nxt.focus(); nxt.select(); nxt.scrollIntoView({ block: 'center', behavior: 'smooth' }); } else (sideEl.querySelector('#osm-given') as HTMLElement | null)?.focus(); }
            });
            inp.addEventListener('focus', () => inp.select());
            inp.addEventListener('blur', () => { const d = doc.marks?.[qk(i)]; if (d && inp.value.trim() !== '') inp.value = String(d.v); });
        });
        sideEl.querySelectorAll<HTMLButtonElement>('.osm-mini').forEach(b => b.addEventListener('click', () => {
            const row = b.closest('.osm-q') as HTMLElement; const i = Number(row.dataset.i); const inp = row.querySelector('.osm-in') as HTMLInputElement; const max = qMax(paper.questions[i]);
            const cur = doc.marks?.[qk(i)]?.v; let v: number;
            if (b.dataset.act === 'full') v = max;
            else if (b.dataset.act === 'inc') v = Math.min(max || Infinity, (cur ?? 0) + 0.5);
            else v = Math.max(0, (cur ?? 0) - 0.5);
            inp.value = String(v); queueSave(i, inp.value, inp, true);
        }));
        sideEl.querySelectorAll<HTMLButtonElement>('.osm-nab').forEach(b => b.addEventListener('click', () => setNA(Number(b.dataset.i), !doc.marks?.[qk(Number(b.dataset.i))]?.na)));
        sideEl.querySelectorAll<HTMLButtonElement>('.osm-cv').forEach(b => b.addEventListener('click', () => {
            const row = b.closest('.osm-q') as HTMLElement; const i = Number(row.dataset.i); const inp = row.querySelector('.osm-in') as HTMLInputElement;
            inp.value = b.dataset.v!; queueSave(i, inp.value, inp, true);
        }));
        sideEl.querySelectorAll<HTMLButtonElement>('.osm-rbtn').forEach(b => b.addEventListener('click', () => {
            const ta = sideEl.querySelector(`.osm-reason[data-i="${b.dataset.i}"]`) as HTMLTextAreaElement | null; if (!ta) return; const bx = ta.closest('.osm-reasonbox') as HTMLElement;
            const show = bx.style.display === 'none'; bx.style.display = show ? 'block' : 'none'; if (show) ta.focus();
        }));
        sideEl.querySelectorAll<HTMLTextAreaElement>('.osm-reason').forEach(ta => ta.addEventListener('input', () => queueNote(Number(ta.dataset.i), ta.value)));
        updateMine();
        sideEl.querySelector('#osm-given')!.addEventListener('click', toggleDone);
        sideEl.querySelector('#osm-next')?.addEventListener('click', () => pos < order.length - 1 && openDesk(roster, paper, teachers, order[pos + 1], order, view));
    }
    // Optional teacher reason for cut marks: autosaved per question; merge-write of ONE field, so co-teachers never overwrite each other.
    function queueNote(i: number, text: string) {
        const btn = sideEl.querySelector(`.osm-rbtn[data-i="${i}"]`); btn?.classList.toggle('has', !!text.trim()); { const em = btn?.querySelector('em'); if (em) em.textContent = text.trim() ? (text.trim().length > 40 ? text.trim().slice(0, 40) + '…' : text.trim()) : 'private · guides the AI feedback'; }
        const t = text.trim(); const hadNote = !!doc.notes?.[qk(i)]; const entry: any = t ? { t: text, by: me.uid, n: me.name, at: Date.now() } : null;
        if (t) (doc.notes ||= {})[qk(i)] = entry; else if (doc.notes) delete doc.notes[qk(i)];
        obEnqueue({ key: `note:${paper.id}:${studentUid}:${qk(i)}`, kind: 'note', by: me.uid, owner: paper.owner, pid: paper.id, suid: studentUid, at: Date.now(), data: { qk: qk(i), qLabel: 'Q' + (paper.questions[i].questionNumber || i + 1), entry, prev: hadNote } }, 800);
    }
    function queueSave(i: number, raw: string, inp: HTMLInputElement, immediate = false) {
        const max = qMax(paper.questions[i]);
        if (raw.trim() === '') return;   // clearing a box does not delete a saved mark by accident
        if (/[.,]$/.test(raw.trim())) return;   // still typing "1." — wait for the next digit
        let v = Math.round(parseFloat(raw.replace(',', '.')) * 2) / 2;   // marks are in half-mark steps
        if (isNaN(v) || v < 0) v = 0; if (max > 0 && v > max) { v = max; toast(`Q${paper.questions[i].questionNumber || i + 1} is out of ${fmt1(max)} — set to ${fmt1(max)}.`, 'info'); }
        if (document.activeElement !== inp) inp.value = String(v);
        const prevV = doc.marks?.[qk(i)]?.na ? 'na' : doc.marks?.[qk(i)]?.v;
        const entry = { v, na: false, by: me.uid, n: me.name, t: Date.now() };   // na:false overwrites an older 'not attempted' flag when the entry is merged in the cloud
        (doc.marks ||= {})[qk(i)] = entry;
        // Editing a mark after "Completed" reopens this teacher's own done flag, so it can never be stale.
        const reopened = !!doc.done?.[me.uid]; if (reopened) delete doc.done![me.uid];
        // saved on this device at once; sent to the cloud right after (and re-sent automatically if it cannot be)
        obEnqueue({ key: `mark:${paper.id}:${studentUid}:${qk(i)}`, kind: 'mark', by: me.uid, owner: paper.owner, pid: paper.id, suid: studentUid, at: Date.now(), data: { qk: qk(i), qLabel: 'Q' + (paper.questions[i].questionNumber || i + 1), entry, prev: prevV, reopen: reopened, studentName: doc.studentName || stu?.name || '', rollNumber: doc.rollNumber || stu?.rollNumber || '' } }, immediate ? 0 : 600);
        if (fbReport) applyMarkToReport(i, v);   // already analysed: keep the report in step
        // marks given to one half of an OR pair: the other half (if still unmarked and yours) becomes 'not attempted'
        if (v > 0) { let auto = false; partnersOf(i).forEach(j => { if (doc.marks?.[qk(j)] === undefined && editable(j)) { setNA(j, true, true); auto = true; } }); if (auto) { renderSideKeepFocus(reopened); refreshScoreOnly(); return; } }
        if (reopened) renderSideKeepFocus();
        refreshScoreOnly();
    }
    // "Not attempted": greyed out, no marks, never counted as a weakness. Typing a mark afterwards switches it off again.
    const clearedAt: Record<string, number> = {};   // when this teacher switched 'not attempted' off here: an older copy coming back from the cloud must not undo it
    function setNA(i: number, on: boolean, quiet = false) {
        const prevM = doc.marks?.[qk(i)];
        const entry: any = on ? { v: 0, na: true, by: me.uid, n: me.name, t: Date.now() } : null;
        if (on) (doc.marks ||= {})[qk(i)] = entry; else { if (doc.marks) delete doc.marks[qk(i)]; clearedAt[qk(i)] = Date.now(); }
        const reopened = !!doc.done?.[me.uid]; if (reopened) delete doc.done![me.uid];
        obEnqueue({ key: `mark:${paper.id}:${studentUid}:${qk(i)}`, kind: 'mark', by: me.uid, owner: paper.owner, pid: paper.id, suid: studentUid, at: Date.now(), data: { qk: qk(i), qLabel: 'Q' + (paper.questions[i].questionNumber || i + 1), entry, prev: prevM?.na ? 'na' : prevM?.v, reopen: reopened, studentName: doc.studentName || stu?.name || '', rollNumber: doc.rollNumber || stu?.rollNumber || '' } }, 0);
        if (fbReport) applyMarkToReport(i, 0);
        if (!quiet) renderSide(); if (reopened && !quiet) toast('You changed a mark, so “Completed” was reopened — click it again when finished.', 'info');
    }
    // The other half of an "Alternative Question (OR)": the one named in the instructions ("… with Question 15.B")
    const normQ = (x: any) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const partnersOf = (i: number): number[] => { const m = String(paper.questions[i]?.checkingInstructions || '').match(/alternative question \(or\) with question\s+([\w.\-()]+?)(?:\.\s|\.$|,|;|\s|$)/i); if (!m) return []; const want = normQ(m[1]); return paper.questions.map((_: any, j: number) => j).filter(j => j !== i && normQ(paper.questions[j].questionNumber) === want); };
    function renderSideKeepFocus(notify = true) {
        const a = document.activeElement as HTMLInputElement | null; const i = a?.classList.contains('osm-in') ? a.dataset.i : null; const v = a?.value;
        renderSide();
        if (i != null) { const n = sideEl.querySelector(`.osm-in[data-i="${i}"]`) as HTMLInputElement | null; if (n) { n.value = v ?? n.value; n.focus(); } }
        if (notify) toast('You changed a mark, so “Completed” was reopened — click it again when finished.', 'info');
    }
    // "your part": how many of YOUR questions are marked, and whether you have clicked Completed (your name turns green only then)
    function updateMine() {
        const el = sideEl.querySelector('#osm-mine') as HTMLElement | null; if (!el || !showMine) return;
        const mine = [...myIdx]; const marked = mine.filter(i => doc.marks?.[qk(i)] !== undefined).length; const done = !!doc.done?.[me.uid];
        el.className = 'osm-mine ' + (done ? 'ok' : marked === mine.length ? 'ready' : '');
        el.innerHTML = `<span><b>Your questions:</b> ${marked} of ${mine.length} marked</span><span>${done ? '✓ Completed' : marked === mine.length ? 'All marked — click <b>Completed</b>' : 'not completed yet'}</span>`;
    }
    // Both halves of an "Alternative Question (OR)" carry marks: probably a slip, tell the teacher.
    function updateOrWarn() {
        const box = sideEl.querySelector('#osm-orwarn') as HTMLElement | null; if (!box) return;
        const has = (j: number) => { const m = doc.marks?.[qk(j)]; return !!m && !m.na; };
        const pairs: [number, number][] = []; paper.questions.forEach((_: any, i: number) => partnersOf(i).forEach(j => { if (i < j && has(i) && has(j)) pairs.push([i, j]); }));
        if (!pairs.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
        const lab = (i: number) => 'Q' + (paper.questions[i].questionNumber || i + 1);
        box.innerHTML = pairs.map(([a, b]) => `<div class="osm-orw"><b>⚠ ${esc(lab(a))} and ${esc(lab(b))}</b> are alternative choices (OR) but <b>both have marks</b>. The student should answer only one: please set the other to <b>Not attempted</b>. <span class="osm-orgo"><button data-i="${a}">Go to ${esc(lab(a))}</button><button data-i="${b}">Go to ${esc(lab(b))}</button></span></div>`).join('');
        box.style.display = 'block';
        box.querySelectorAll<HTMLButtonElement>('.osm-orgo button').forEach(bt => bt.addEventListener('click', () => (sideEl.querySelector(`.osm-rb[data-i="${bt.dataset.i}"]`) as HTMLElement | null)?.click()));
    }
    function refreshScoreOnly() {
        updateOrWarn();
        updateMine();
        const sc = scoreFor(paper, doc.marks); const dt = declaredTotal(paper);
        const n = sideEl.querySelector('.osm-score-num'); if (n) n.innerHTML = `${fmt1(sc.total)}<small> / ${dt || '—'}</small>`;
        const mk = sideEl.querySelector('#osm-marked'); if (mk) mk.textContent = `${sc.marked}/${sc.count}`;
        const bar = sideEl.querySelector('.osm-bar i') as HTMLElement | null; if (bar) bar.style.width = (dt ? Math.min(100, sc.total / dt * 100) : 0) + '%';
        sideEl.querySelectorAll<HTMLElement>('.osm-q').forEach(r => { const i = Number(r.dataset.i); const q = paper.questions[i]; r.classList.toggle('has', doc.marks?.[qk(i)] !== undefined); r.classList.toggle('na', !!doc.marks?.[qk(i)]?.na); r.querySelector('.osm-nab')?.classList.toggle('on', !!doc.marks?.[qk(i)]?.na); { const ie = r.querySelector('.osm-in') as HTMLInputElement | null; if (ie && doc.marks?.[qk(i)]?.na) ie.value = ''; } r.style.setProperty('--c', qColor(doc.marks?.[qk(i)], qMax(q))); { const rb = sideEl.querySelector(`.osm-rb[data-i="${i}"]`) as HTMLElement | null; if (rb) { rb.classList.toggle('has', doc.marks?.[qk(i)] !== undefined); rb.classList.toggle('na', !!doc.marks?.[qk(i)]?.na); rb.style.setProperty('--c', qColor(doc.marks?.[qk(i)], qMax(q))); } } { const cur = doc.marks?.[qk(i)]?.na ? undefined : doc.marks?.[qk(i)]?.v; r.querySelectorAll<HTMLElement>('.osm-cv').forEach(c => c.classList.toggle('sel', cur !== undefined && Number(c.dataset.v) === cur)); } r.classList.toggle('loser', sc.losers.has(q.questionNumber || String(i + 1))); });
    }
    async function toggleDone() {
        await flushMarks();   // a mark typed a moment ago must count
        const iAmDone = !!doc.done?.[me.uid];
        if (!iAmDone) {
            const mine = paper.questions.map((_, i) => i).filter(i => hasAssign ? myIdx.has(i) : true);
            // An unattempted alternative (OR) question needs no mark when its partner has one: it is saved as 0 for you.
            const partnerOf = (i: number) => { const ci = String(paper.questions[i].checkingInstructions || ''); if (!/alternative question \(or\)/i.test(ci)) return -1; const m = ci.match(/with\s+question\s+([\w.\-\s()]+?)(?:\.\s|\.$|,|;|$)/i); if (!m) return -1; const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, ''); return paper.questions.findIndex(q => n(q.questionNumber || '') === n(m[1])); };
            const autoZero = mine.filter(i => doc.marks?.[qk(i)] === undefined && partnerOf(i) >= 0 && doc.marks?.[qk(partnerOf(i))] !== undefined);
            for (const i of autoZero) queueSave(i, '0', document.createElement('input'), true);   // unattempted OR alternative: saved as 0 (logged like any mark)
            if (autoZero.length) renderSide();
            const missing = mine.filter(i => doc.marks?.[qk(i)] === undefined);
            if (missing.length) {
                const first = missing[0];
                toast(`${missing.length} question(s) still have no mark (first: Q${paper.questions[first].questionNumber || first + 1}). Enter 0 if the student scored nothing.`, 'error');
                const row = sideEl.querySelector(`.osm-q[data-i="${first}"]`) as HTMLElement | null; row?.scrollIntoView({ block: 'center', behavior: 'smooth' }); row?.classList.add('flash'); setTimeout(() => row?.classList.remove('flash'), 1500);
                return;
            }
        }
        try {
            const ref = stuRef(paper, studentUid);
            if (iAmDone) { await ref.update({ ['done.' + me.uid]: B.FieldValue.delete() }); delete doc.done![me.uid]; }
            else { await ref.set({ done: { [me.uid]: { n: me.name, t: Date.now() } } }, { merge: true }); (doc.done ||= {})[me.uid] = { n: me.name, t: Date.now() }; }
            obLog({ by: me.uid, owner: paper.owner, pid: paper.id, suid: studentUid }, { type: 'done', text: iAmDone ? 'Reopened the marking for editing' : 'Clicked “Completed” (marks verified)' });
            renderSide();
            toast(iAmDone ? 'Reopened for editing.' : 'Completed ✓', 'success');
        } catch (e: any) { toast('Could not update: ' + e.message, 'error'); }
    }
    renderSide();
    // 🎤 speak instead of typing: the browser's own speech recognition (asks for the microphone once). Works in every text box where feedback is written.
    {
        const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition; let rec: any = null; let recBtn: HTMLElement | null = null;
        const getLang = () => 'en-IN';   // English only
        const stopRec = () => { try { rec?.stop(); } catch { /* */ } rec = null; if (recBtn) { recBtn.classList.remove('on'); const sp = recBtn.querySelector('span'); if (sp) sp.textContent = 'Speak'; } recBtn = null; };
        const MIC = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>';
        const decorate = () => sideEl.querySelectorAll<HTMLTextAreaElement>('.osm-reason,.osm-fbta,.osm-ovta').forEach(ta => {
            if (ta.parentElement?.classList.contains('osm-micwrap') || ta.disabled) return;
            const w = document.createElement('div'); w.className = 'osm-micwrap'; ta.parentElement!.insertBefore(w, ta); w.appendChild(ta);
            w.insertAdjacentHTML('beforeend', `<button type="button" class="osm-mic" title="Speak instead of typing: click, talk, click again to stop">${MIC}<span>Speak</span></button>`);
            const mic = w.querySelector('.osm-mic') as HTMLElement;
            mic.addEventListener('mousedown', e => e.preventDefault());
            mic.addEventListener('click', () => {
                if (rec && recBtn === mic) { stopRec(); return; }
                stopRec();
                if (!SR) { toast('Voice typing needs Chrome or Edge. Please type here, or open ClassMap in Chrome.', 'info'); return; }
                const r = new SR(); r.lang = getLang(); r.continuous = true; r.interimResults = true; rec = r; recBtn = mic; mic.classList.add('on'); mic.querySelector('span')!.textContent = 'Stop';
                const base = ta.value; let finalTxt = '';
                r.onresult = (ev: any) => { let interim = ''; for (let k = ev.resultIndex; k < ev.results.length; k++) { const t = ev.results[k][0].transcript; if (ev.results[k].isFinal) finalTxt += (finalTxt && !/\s$/.test(finalTxt) ? ' ' : '') + t.trim(); else interim += t; }
                    ta.value = (base ? base.replace(/\s+$/, '') + ' ' : '') + finalTxt + (interim ? (finalTxt ? ' ' : '') + interim : ''); ta.dispatchEvent(new Event('input', { bubbles: true })); };
                r.onerror = (ev: any) => { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') toast('Microphone is blocked. Click the lock icon in the address bar, allow the microphone for this site, then try again.', 'error'); else if (ev.error === 'network') toast('Voice typing could not reach the browser’s speech service. It works in Google Chrome or Edge, but not in Brave. Please open ClassMap in Chrome, or type here.', 'error'); else if (ev.error !== 'no-speech' && ev.error !== 'aborted') toast('Voice typing stopped (' + ev.error + ').', 'info'); stopRec(); };
                r.onend = () => { if (rec === r) { try { r.start(); } catch { stopRec(); } } };   // keeps listening through pauses until you click the mic again
                try { r.start(); } catch { stopRec(); }
            });
        });
        const mo = new MutationObserver(decorate); mo.observe(sideEl, { childList: true, subtree: true }); decorate();
        stopListeners.push(() => { mo.disconnect(); stopRec(); });
    }
    updateMine();
    const onSync = () => renderSync(); ob.subs.add(onSync); stopListeners.push(() => ob.subs.delete(onSync)); renderSync();
    desk.querySelector('#osm-hist')!.addEventListener('click', () => openHistory());
    // History: every confirmed change on this sheet (marks, reason notes, feedback edits, annotations), by every teacher; AI feedback is listed too.
    async function openHistory() {
        document.querySelectorAll('.osm-hist-back').forEach(n => n.remove());
        const back = document.createElement('div'); back.className = 'osm-hist-back';
        back.innerHTML = `<div class="osm-hist"><div class="osm-hist-h"><b>Change history</b><span class="osm-sub">${esc(doc.studentName || stu?.name || '')} · Roll ${esc(doc.rollNumber || stu?.rollNumber || '')}</span><button class="osm-btn small" id="hist-x">Close</button></div>
          <div class="osm-hist-note">Marks are only ever entered or changed by teachers. The AI writes feedback and the learning analysis only, and never changes a mark.</div>
          <div id="hist-conf"></div><div class="osm-hist-sum" id="hist-sum"></div>
          <div class="osm-hist-f"><select id="hist-q"><option value="">All questions</option></select><select id="hist-p"><option value="">Everyone</option></select></div>
          <div class="osm-hist-l" id="hist-l"><div class="osm-sub" style="padding:14px">Loading…</div></div></div>`;
        document.body.appendChild(back); back.addEventListener('click', e => { if (e.target === back) back.remove(); }); back.querySelector('#hist-x')!.addEventListener('click', () => back.remove());
        let evs: any[] = [];
        try { const snap = await paperRef(paper.owner, paper.id).collection('submissions').doc(studentUid).collection('detail').get(); snap.docs.forEach((d: any) => { if (d.id.startsWith('osmLog_')) evs.push(...(d.data().events || [])); }); } catch (e: any) { (back.querySelector('#hist-l') as HTMLElement).innerHTML = `<div class="osm-sub" style="padding:14px">Could not load the history: ${esc(e.message)}</div>`; return; }
        const seen = new Set(evs.map(e => e.id)); ob.ops.forEach(o => { if (o.kind === 'log' && o.suid === studentUid && o.pid === paper.id && !seen.has(o.data.id)) evs.push({ ...o.data, pendingSave: true }); });
        evs.sort((a, b) => b.t - a.t);
        // questions that more than one teacher gave a mark to are shown separately, with each teacher's value
        { const val = (e: any) => e.v !== undefined ? e.v : ((String(e.text).match(/→\s*(.+)$/) || [])[1] || '?');
          const byQ = new Map<string, any[]>(); evs.filter(e => e.type === 'mark' && e.q).forEach(e => { if (!byQ.has(e.q)) byQ.set(e.q, []); byQ.get(e.q)!.push(e); });
          const conf = [...byQ.entries()].filter(([, l]) => new Set(l.map(e => e.by)).size > 1).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
          (back.querySelector('#hist-conf') as HTMLElement).innerHTML = conf.length ? `<div class="osm-hist-conf"><b>⚠ ${conf.length} question${conf.length > 1 ? 's were' : ' was'} marked by more than one teacher</b>${conf.map(([q, l]) => { const sorted = [...l].sort((a, b) => a.t - b.t); const last = sorted[sorted.length - 1]; return `<div><b>${esc(q)}</b>: ${sorted.map(e => `${esc(e.n || 'Teacher')} gave ${esc(val(e))}`).join(' → ')} &nbsp;·&nbsp; <b>counted now: ${esc(val(last))}</b> (${esc(last.n || 'Teacher')}, the latest)</div>`; }).join('')}</div>` : '';
          const per = new Map<string, { m: number; no: number; ink: number; fb: number }>(); evs.forEach(e => { if (e.type === 'ai') return; const k = e.n || 'Teacher'; const c = per.get(k) || { m: 0, no: 0, ink: 0, fb: 0 }; if (e.type === 'mark') c.m++; else if (e.type === 'note') c.no++; else if (e.type === 'ink') c.ink++; else if (e.type === 'feedback') c.fb++; per.set(k, c); });
          (back.querySelector('#hist-sum') as HTMLElement).innerHTML = [...per.entries()].map(([n, c]) => `<b>${esc(n)}</b>: ${c.m} mark change${c.m === 1 ? '' : 's'}, ${c.no} note${c.no === 1 ? '' : 's'}, ${c.ink} annotation edit${c.ink === 1 ? '' : 's'}${c.fb ? `, ${c.fb} feedback edit${c.fb === 1 ? '' : 's'}` : ''}`).join(' &nbsp;|&nbsp; '); }
        const qSel = back.querySelector('#hist-q') as HTMLSelectElement, pSel = back.querySelector('#hist-p') as HTMLSelectElement;
        [...new Set(evs.map(e => e.q).filter(Boolean))].sort((a: any, b: any) => a.localeCompare(b, undefined, { numeric: true })).forEach((q: any) => qSel.insertAdjacentHTML('beforeend', `<option>${esc(q)}</option>`));
        [...new Set(evs.map(e => e.n || 'Teacher'))].forEach((n: any) => pSel.insertAdjacentHTML('beforeend', `<option>${esc(n)}</option>`));
        const draw = () => {
            const list = evs.filter(e => (!qSel.value || e.q === qSel.value) && (!pSel.value || (e.n || 'Teacher') === pSel.value));
            (back.querySelector('#hist-l') as HTMLElement).innerHTML = list.length ? list.map(e => `<div class="osm-hist-r ${e.type === 'ai' ? 'ai' : ''}"><div class="osm-hist-t">${esc(new Date(e.t).toLocaleString())}</div><div><b>${e.type === 'ai' ? 'AI (feedback only)' : esc(e.n || 'Teacher')}</b> — ${esc(e.text)}${e.pendingSave ? ' <i>(saving…)</i>' : ''}</div></div>`).join('') : '<div class="osm-sub" style="padding:14px">Nothing recorded yet for this selection. Changes from now on are logged automatically.</div>';
        };
        qSel.onchange = draw; pSel.onchange = draw; draw();
    }

    // live updates from co-teachers (does not disturb a box you are typing in)
    const unsub = stuRef(paper, studentUid).onSnapshot((snap: any) => {
        if (!snap.exists || snap.metadata.hasPendingWrites) return;
        const d = snap.data(); const active = document.activeElement as HTMLInputElement | null;
        let changed = false;
        Object.entries(doc.marks || {}).forEach(([k, m]: any) => { if (m?.na && !(d.marks || {})[k] && ![...ob.ops.values()].some(o => o.kind === 'mark' && o.suid === studentUid && o.pid === paper.id && o.data.qk === k)) { delete doc.marks![k]; changed = true; } });   // cleared on another screen
        Object.entries(d.marks || {}).forEach(([k, v]: any) => { if (clearedAt[k] && v.t <= clearedAt[k]) return; const cur = doc.marks?.[k]; if (!cur || cur.t < v.t) { if (!(active?.classList.contains('osm-in') && qk(Number(active.dataset.i)) === k)) { (doc.marks ||= {})[k] = v; changed = true; } } });
        const nd = JSON.stringify(Object.keys(d.done || {}).sort()); if (nd !== JSON.stringify(Object.keys(doc.done || {}).sort())) { doc.done = d.done || {}; changed = true; }
        if (!changed) return;
        Object.entries(d.notes || {}).forEach(([k, v]: any) => { const mine = active?.classList.contains('osm-reason') && qk(Number(active.dataset.i)) === k; if (!mine && doc.notes?.[k]?.t !== v.t) { (doc.notes ||= {})[k] = v; changed = true; } });
        if (!changed) return;
        if (view === 'fb') return;
        if (!active?.matches('.osm-in,.osm-reason')) renderSide();
        else {   // you are typing: update every OTHER box in place, never the one you are in
            sideEl.querySelectorAll<HTMLInputElement>('.osm-in').forEach(inp => { if (inp !== active) { const m = doc.marks?.[qk(Number(inp.dataset.i))]; if (m) inp.value = String(m.v); } });
            sideEl.querySelectorAll<HTMLTextAreaElement>('.osm-reason').forEach(ta => { if (ta !== (active as any)) { const n = doc.notes?.[qk(Number(ta.dataset.i))]; if (n && ta.value !== n.t) { ta.value = n.t; ta.style.display = 'block'; sideEl.querySelector(`.osm-rbtn[data-i="${ta.dataset.i}"]`)?.classList.add('has'); } } });
            refreshScoreOnly();
        }
    }, (e: any) => console.warn('[osm] live listener', e));
    stopListeners.push(unsub);
    stopListeners.push(() => { flushFb(); });
    stopListeners.push(() => { flushInk(); alive = false; window.removeEventListener('beforeunload', warnUnload); window.removeEventListener('pagehide', flushInk); Object.keys(saveTimers).forEach(k => { /* pending mark saves are flushed below */ }); flushMarks(); });
}

// ───────────────────────── styles (ClassMap look: Poppins, blue→purple gradient, soft rounded cards) ─────────────────────────
function injectStyle() {
    if (document.getElementById('osm-style')) return;
    if (!document.getElementById('osm-font')) { const l = document.createElement('link'); l.id = 'osm-font'; l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'; document.head.appendChild(l); }
    const s = document.createElement('style'); s.id = 'osm-style';
    s.textContent = `
#osm-root{position:fixed;inset:0;z-index:9000;background:var(--osm-bg);color:var(--osm-fg);display:none;overflow:auto;font-family:'Poppins',system-ui,sans-serif;
 --osm-bg:#f5f7fa;--osm-card:#ffffff;--osm-fg:#34495e;--osm-muted:#7f8c8d;--osm-line:#e3e8f0;--osm-accent:#2575fc;--osm-accent2:#6a11cb;--osm-grad:linear-gradient(135deg,#2575fc 0%,#6a11cb 100%);--osm-accent-fg:#fff;--osm-warn:#b45309;--osm-bad:#e74c3c;--osm-ok:#1e9e5a;--osm-soft:#eef3ff;--osm-shadow:0 4px 18px rgba(37,117,252,.10)}
body.osm-active{overflow:hidden}
#osm-root *{box-sizing:border-box}
.osm-top,.osm-desk-top{display:flex;align-items:center;gap:16px;padding:14px 22px;background:var(--osm-grad);color:#fff;position:sticky;top:0;z-index:5;box-shadow:0 2px 14px rgba(106,17,203,.25)}
.osm-titlebox{flex:1;min-width:0}.osm-title{font-size:1.15rem;font-weight:600}.osm-top .osm-sub,.osm-desk-top .osm-sub{color:rgba(255,255,255,.82)}.osm-sub{font-size:.82rem;color:var(--osm-muted)}
.osm-body{max-width:1180px;margin:0 auto;padding:24px 20px 60px}
.osm-btn{border:1px solid var(--osm-line);background:var(--osm-card);color:var(--osm-fg);border-radius:12px;padding:9px 16px;font-size:.88rem;cursor:pointer;font-family:inherit;font-weight:500;display:inline-flex;align-items:center;gap:6px;transition:all .15s}
.osm-btn:hover{background:var(--osm-soft);border-color:#c9d8fb}.osm-btn.primary{background:var(--osm-grad);color:#fff;border-color:transparent;box-shadow:0 3px 10px rgba(37,117,252,.3)}.osm-btn.primary:hover{filter:brightness(1.07);background:var(--osm-grad)}
.osm-btn.ghost{border-color:transparent;background:rgba(255,255,255,.16);color:#fff}.osm-btn.ghost:hover{background:rgba(255,255,255,.28)}.osm-btn.small{padding:6px 12px;font-size:.82rem;border-radius:10px}.osm-btn.wide{width:100%;justify-content:center;padding:12px;font-size:1rem;border-radius:14px}.osm-btn:disabled{opacity:.45;cursor:not-allowed}
.osm-toolbar{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:16px}.osm-toolbar-btns{display:flex;gap:8px;flex-wrap:wrap}
.osm-empty{text-align:center;padding:60px 20px;color:var(--osm-muted)}.osm-center{display:flex;justify-content:center;padding:80px}
.osm-spin{width:34px;height:34px;border-radius:50%;border:3px solid var(--osm-line);border-top-color:var(--osm-accent);animation:osmspin .8s linear infinite}@keyframes osmspin{to{transform:rotate(360deg)}}
.osm-table-wrap{background:var(--osm-card);border:1px solid var(--osm-line);border-radius:18px;overflow:auto;box-shadow:var(--osm-shadow)}
.osm-table{width:100%;border-collapse:collapse;font-size:.88rem}.osm-table th,.osm-table td{padding:11px 14px;border-bottom:1px solid var(--osm-line);text-align:left;vertical-align:middle}.osm-table tbody tr:hover{background:#fafbff}.osm-table tbody tr:last-child td{border-bottom:0}
.osm-table th{background:var(--osm-soft);position:sticky;top:0;font-size:.74rem;text-transform:uppercase;letter-spacing:.05em;color:#5b6b86;font-weight:600}.osm-nm{font-weight:500}.osm-pgs{font-weight:500}
.osm-kpis{display:flex;gap:12px}.osm-kpi{background:var(--osm-card);border:1px solid var(--osm-line);border-radius:16px;padding:10px 20px;display:flex;flex-direction:column;box-shadow:var(--osm-shadow)}.osm-kpi b{font-size:1.5rem;background:var(--osm-grad);-webkit-background-clip:text;background-clip:text;color:transparent;line-height:1.2}.osm-kpi b small{font-size:.9rem;color:var(--osm-muted);-webkit-text-fill-color:var(--osm-muted);font-weight:500}.osm-kpi span{font-size:.76rem;color:var(--osm-muted)}
.osm-upst{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:.8rem}.osm-upst.run{color:#2457c5;font-weight:600}.osm-upst.err{color:#c0262d}.osm-upbar{width:90px;height:7px;border-radius:99px;background:#dbe5fb;overflow:hidden}.osm-upbar i{display:block;height:100%;background:#2575fc;transition:width .3s}.osm-uperr{width:100%;font-size:.72rem;color:#c0262d;font-weight:400}.osm-pgs.ok{color:#1c7c46;font-weight:600}
.osm-sort{display:inline-flex;align-items:center;gap:6px;font-size:.82rem;color:#5b6b86}.osm-sort select{border:1px solid #cfd8e6;border-radius:8px;padding:5px 8px;background:#fff;font:inherit;color:#243049}.osm-table th.osm-sortable{cursor:pointer;user-select:none}.osm-table th.osm-sortable:hover{color:#2575fc}
.osm-badge{padding:3px 11px;border-radius:99px;font-size:.74rem;font-weight:600;background:#eceff5;color:#5b6b86;white-space:nowrap}.osm-badge.ready{background:#d9f3e6;color:var(--osm-ok)}.osm-badge.prog{background:#fff0d6;color:var(--osm-warn)}.osm-badge.nosheet{background:#f1f2f6;color:#9aa3b2}
.osm-chip{display:inline-block;padding:2px 9px;border-radius:99px;font-size:.74rem;border:1px solid var(--osm-line);color:var(--osm-muted);margin:1px 4px 1px 0}.osm-chip.on{background:#d9f3e6;color:var(--osm-ok);border-color:#b8e6cd}
button.osm-link{background:none;border:0;color:var(--osm-accent);cursor:pointer;font-size:.82rem;margin-left:6px;text-decoration:underline;font-family:inherit;padding:0}.osm-muted{color:var(--osm-muted)}
.osm-banner{padding:12px 16px;border-radius:14px;margin:0 0 14px}.osm-banner.ok{background:#d9f3e6;color:var(--osm-ok)}.osm-banner.small{padding:8px 12px;font-size:.86rem;margin:8px 0}
.osm-modal{position:fixed;inset:0;background:rgba(20,24,45,.5);z-index:9500;display:flex;align-items:center;justify-content:center;padding:20px;font-family:'Poppins',system-ui,sans-serif}.osm-modal-card{background:#fff;color:#34495e;border-radius:20px;padding:24px;max-width:640px;width:100%;max-height:88vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)}.osm-modal-card h3{margin:0 0 4px}
.osm-modal .osm-btn{background:#fff;color:#34495e}.osm-modal .osm-btn.primary{background:var(--osm-grad,linear-gradient(135deg,#2575fc,#6a11cb));color:#fff}.osm-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
.osm-drop{border:2px dashed #b9c8ee;border-radius:16px;padding:26px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;margin:14px 0;background:#f7f9ff;color:#5b6b86}.osm-drop.over{background:#e8f0ff;border-color:#2575fc}
.osm-files{list-style:none;margin:0 0 6px;padding:0;max-height:140px;overflow:auto;font-size:.86rem}.osm-files li{padding:4px 0;border-bottom:1px solid #eef1f7}.osm-files small{color:#8a96a8}
.osm-choice{display:flex;flex-direction:column;gap:8px;margin-top:10px}.osm-radio{display:flex;gap:10px;align-items:flex-start;border:1px solid #e3e8f0;border-radius:12px;padding:10px 12px;font-size:.86rem;cursor:pointer}.osm-radio:has(input:checked){border-color:#2575fc;background:#f2f6ff}.osm-radio input{margin-top:4px}
.osm-range{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}.osm-checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:6px;margin:10px 0}.osm-check{border:1px solid #e3e8f0;border-radius:10px;padding:6px 8px;font-size:.86rem;display:flex;gap:6px;align-items:center;cursor:pointer}.osm-check small{color:#888;margin-left:auto}
/* desk */
.osm-desk{--osm-bg:#f5f7fa;position:fixed;inset:0;display:flex;flex-direction:column;background:#2b3040}
.osm-desk.dark{--osm-bg:#1b1f2b;--osm-card:#252a38;--osm-fg:#e6e9f2;--osm-muted:#9aa3b8;--osm-line:#363d50;--osm-soft:#2d3446;--osm-accent:#6ea0ff}
.osm-desk-top{flex-wrap:wrap;padding:10px 20px}
.osm-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.osm-seg{display:inline-flex;border:1px solid rgba(255,255,255,.35);border-radius:11px;overflow:hidden}.osm-seg button{border:0;background:rgba(255,255,255,.12);color:#fff;padding:7px 13px;cursor:pointer;font-size:.84rem;font-family:inherit}.osm-seg button.on{background:#fff;color:#2575fc;font-weight:600}
.osm-tools input[type=color]{width:34px;height:32px;border:1px solid rgba(255,255,255,.4);border-radius:9px;padding:2px;background:rgba(255,255,255,.2)}.osm-tools select{padding:6px;border-radius:9px;border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.18);color:#fff;font-family:inherit}.osm-tools select option{color:#222}
.osm-desk-top .osm-btn.small{background:rgba(255,255,255,.14);color:#fff;border-color:rgba(255,255,255,.35)}
.osm-inkstat{font-size:.78rem;padding:5px 11px;border-radius:99px;background:rgba(255,255,255,.16);color:#fff;white-space:nowrap}.osm-inkstat.saved,.osm-inkstat.idle{background:rgba(46,204,113,.28)}.osm-inkstat.dirty,.osm-inkstat.saving{background:rgba(255,193,7,.35)}.osm-inkstat.error{background:#e74c3c}
.osm-desk-main{flex:1;display:flex;min-height:0}
#osm-root .osm-btn.osm-pubsoft{background:#f1f5f4;color:#4b6358;border:1px solid #cfdad5;box-shadow:none;font-weight:500}#osm-root .osm-btn.osm-pubsoft:hover{background:#e4ece8}
.osm-table tr.osm-dim{opacity:.5}.osm-stu-det{margin:10px 0;border:1px solid var(--osm-line,#e3e6f3);border-radius:10px;padding:8px 12px}.osm-stu-det summary{cursor:pointer;font-weight:600}.osm-stu-checks{max-height:200px;overflow:auto}
.osm-attn{animation:osmattn 1.4s ease-in-out infinite}@keyframes osmattn{0%,100%{box-shadow:0 0 0 0 rgba(37,117,252,.55)}50%{box-shadow:0 0 0 8px rgba(37,117,252,0)}}
.osm-pickbanner{margin:10px 0;padding:9px 13px;border-radius:10px;background:#fff6df;border:1.5px solid #e8a100;color:#6f4700;font-size:.85rem}
.osm-rb.mine{box-shadow:0 0 0 2px #2575fc;font-weight:800}.osm-rb.notmine{opacity:.45}
.osm-mine{display:flex;justify-content:space-between;gap:8px;margin-top:5px;padding:4px 9px;border-radius:8px;background:#eef3ff;color:#2a4fb0;font-size:.72rem}.osm-mine.ready{background:#fff6df;color:#8a5a00}.osm-mine.ok{background:#e8f6ee;color:#17613a}
.osm-tour-back{position:fixed;inset:0;z-index:100003;background:rgba(15,20,40,.6);display:flex;align-items:center;justify-content:center;padding:16px}
.osm-tour{background:#fff;color:#1b1f3b;border-radius:16px;width:min(520px,100%);box-shadow:0 20px 60px rgba(0,0,0,.4);font-family:Inter,Poppins,system-ui,sans-serif;overflow:hidden}
.osm-tour-h{display:flex;justify-content:space-between;padding:12px 18px;background:linear-gradient(135deg,#6a11cb,#2575fc);color:#fff;font-size:.9rem}.osm-tour-body{padding:16px 20px 6px;min-height:150px}.osm-tour-body h4{margin:0 0 8px;font-size:1.05rem}.osm-tour-body p{margin:0;line-height:1.6;font-size:.92rem}
.osm-tour-dots{display:flex;gap:5px;justify-content:center;padding:8px}.osm-tour-dots i{width:7px;height:7px;border-radius:50%;background:#d7dcec}.osm-tour-dots i.on{background:#2575fc}.osm-tour-f{display:flex;gap:8px;padding:10px 16px 14px}
.osm-hist-conf{margin:8px 18px 0;padding:8px 12px;border:1.5px solid #e8a100;background:#fff8e6;border-radius:10px;font-size:12.5px;color:#6f4700}.osm-hist-conf b{color:#8a5a00}.osm-hist-conf div{margin-top:3px}
.osm-hist-sum{margin:8px 18px 0;font-size:12px;color:#4a5170}
.osm-qfoot{display:flex!important;flex-wrap:nowrap;align-items:center;justify-content:space-between;gap:8px;margin-top:4px!important;min-height:22px}
.osm-qfoot .osm-by{margin:0!important;font-size:.7rem!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#osm-root .osm-qfoot .osm-rbtn{margin:0 0 0 auto!important;width:auto!important;min-height:0!important;height:20px!important;padding:0 8px!important;font-size:.66rem!important;font-weight:600;border-width:1px!important;border-radius:99px!important;display:inline-flex!important;align-items:center;gap:4px;flex:none;white-space:nowrap}
#osm-root .osm-qfoot .osm-rbtn svg{width:10px!important;height:10px!important}#osm-root .osm-qfoot .osm-rbtn em{display:none}
.osm-q > .osm-det{margin-top:3px!important;font-size:.72rem!important}.osm-q > .osm-det summary{white-space:nowrap}
.osm-qs{overflow-x:hidden!important}
#osm-root .osm-rbtn{width:auto;min-height:0;margin:0;padding:2px 9px;font-size:.7rem;border-width:1px;border-radius:99px;flex:none}#osm-root .osm-rbtn svg{width:11px;height:11px}
.osm-q{padding:4px 8px 5px!important;margin:4px 0!important}.osm-chips{margin-top:3px!important}.osm-foot{padding:6px 10px!important;gap:4px!important}.osm-doneline{margin-bottom:0}
.osm-actions{display:flex;gap:8px;align-items:stretch}.osm-actions #osm-given{flex:1;justify-content:center;font-weight:600}.osm-btn.done{background:#1e8e4e!important;border-color:#1e8e4e!important;color:#fff!important}
#osm-root .osm-rbtn{width:100%;height:auto;min-height:30px;margin-top:6px;display:flex;align-items:center;gap:7px;padding:5px 10px;border:1.5px solid #f2a900;background:#fff8e6;color:#8a5a00;border-radius:10px;font-size:.78rem;font-weight:600;text-align:left;font-family:inherit}
#osm-root .osm-rbtn svg{width:14px;height:14px;flex:none}#osm-root .osm-rbtn em{font-style:normal;font-weight:400;opacity:.8;font-size:.72rem;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#osm-root .osm-rbtn:hover:not(:disabled){background:#ffefc2;border-color:#d99100;color:#6f4700}#osm-root .osm-rbtn.has{background:#f2a900;color:#fff;border-color:#f2a900}#osm-root .osm-rbtn.has em{opacity:.95}
.osm-priv{font-size:.7rem;color:var(--osm-muted);margin-top:3px}.osm-reasonbox{margin-top:2px}
.osm-micwrap{position:relative}.osm-micwrap textarea{padding-bottom:40px!important;box-sizing:border-box}
.osm-mic{position:absolute;right:8px;bottom:8px;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px 0 11px;border:0;border-radius:99px;background:#2575fc;color:#fff;font:inherit;font-size:.82rem;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(37,117,252,.35)}.osm-mic:hover{background:#1c63dd}.osm-mic:disabled{opacity:.75;cursor:wait}
.osm-mic.on{background:#e53935;box-shadow:0 0 0 0 rgba(229,57,53,.5);animation:osmpulse 1.1s infinite}@keyframes osmpulse{0%{box-shadow:0 0 0 0 rgba(229,57,53,.5)}100%{box-shadow:0 0 0 9px rgba(229,57,53,0)}}
.osm-recdot{width:9px;height:9px;border-radius:50%;background:#fff}.osm-spin2{width:13px;height:13px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:osmrot .8s linear infinite}@keyframes osmrot{to{transform:rotate(360deg)}}
.osm-q.na{opacity:.9;background:#eaf3ff!important;border-left-color:#3b8bea!important}.osm-q.na .osm-qn{color:#2a6fc4!important}.osm-q.na .osm-in{background:transparent}
.osm-rb.na{background:#cfe3fb!important;color:#2a6fc4!important;border-color:#3b8bea!important}
.osm-nab{font-size:.68rem!important;padding:0 7px!important;min-width:0!important}.osm-nab.on{background:#6b7280!important;color:#fff!important;border-color:#6b7280!important}
.osm-hist-back{position:fixed;inset:0;z-index:100001;background:rgba(15,20,40,.55);display:flex;align-items:center;justify-content:center;padding:18px}
.osm-hist{background:#fff;color:#1b1f3b;border-radius:16px;width:min(720px,100%);max-height:86vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:Inter,Poppins,system-ui,sans-serif}
.osm-hist-h{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #e6e9f4}.osm-hist-h b{font-size:16px}.osm-hist-h .osm-sub{flex:1;color:#6b7280}
.osm-hist-note{margin:10px 18px 0;padding:8px 12px;background:#eef2ff;border-radius:10px;font-size:12.5px;color:#34408a}
.osm-hist-f{display:flex;gap:8px;padding:10px 18px}.osm-hist-f select{padding:6px 10px;border:1px solid #d7dcec;border-radius:9px;font-family:inherit}
.osm-hist-l{overflow:auto;padding:0 18px 16px;flex:1}.osm-hist-r{display:flex;gap:14px;padding:8px 0;border-bottom:1px solid #eef0f7;font-size:13px;line-height:1.45}.osm-hist-r.ai{background:#f6f0ff;margin:0 -8px;padding:8px}.osm-hist-t{flex:none;width:150px;color:#6b7280;font-size:12px}
.osm-vtools{width:68px;flex:none;display:flex;flex-direction:column;align-items:stretch;gap:4px;padding:10px 6px;background:#242938;overflow-y:auto;border-right:1px solid rgba(255,255,255,.08)}
.osm-vtools .vt{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;border:0;border-radius:11px;background:transparent;color:#dfe4f2;padding:7px 2px;cursor:pointer;font-family:inherit;transition:background .12s,transform .08s}
.osm-vtools .vt span{font-size:10px;font-weight:500;letter-spacing:.2px}.osm-vtools .vt:hover{background:rgba(255,255,255,.1)}.osm-vtools .vt:active{transform:scale(.94)}
.osm-vtools .vt.on{background:#fff;color:#2575fc;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.osm-vtools .vsep{display:block;height:1px;background:rgba(255,255,255,.14);margin:5px 6px}
.osm-vtools .colorlbl input{width:30px;height:26px;border:0;border-radius:7px;padding:0;background:none;cursor:pointer}
.osm-vtools .vw{display:flex;flex-direction:column;gap:3px}.osm-vtools .vwb{border:0;border-radius:9px;background:transparent;color:#dfe4f2;padding:5px 2px;cursor:pointer;font-family:inherit;display:flex;flex-direction:column;align-items:center;gap:3px}
.osm-vtools .vwb i{display:block;width:28px;background:currentColor;border-radius:4px}.osm-vtools .vwb span{font-size:9.5px}.osm-vtools .vwb:hover{background:rgba(255,255,255,.1)}.osm-vtools .vwb.on{background:rgba(255,255,255,.2);color:#fff;box-shadow:inset 0 0 0 1.5px #fff}
.osm-pages-wrap{flex:1;position:relative;min-width:0;display:flex}
.osm-pages{flex:1;overflow:auto;padding:18px 24px 90px;background:#2b3040;display:flex;flex-direction:column;align-items:center;gap:18px}
.osm-zoombar{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:4px;background:rgba(30,34,50,.92);color:#fff;border-radius:99px;padding:5px 8px;box-shadow:0 6px 24px rgba(0,0,0,.4);backdrop-filter:blur(6px);font-size:.84rem;z-index:3}
.osm-zoombar button{border:0;background:transparent;color:#fff;font-size:1.1rem;min-width:34px;height:34px;border-radius:99px;cursor:pointer;font-family:inherit}.osm-zoombar button:hover{background:rgba(255,255,255,.18)}.osm-zoombar span{min-width:48px;text-align:center}.osm-zoombar #z-page{min-width:90px;color:#b9c2da}.osm-zoombar i{width:1px;height:20px;background:rgba(255,255,255,.25);margin:0 4px}
.osm-page{width:100%;display:flex;flex-direction:column;align-items:center}.osm-pg-label{color:#aab3c9;font-size:.76rem;margin-bottom:6px;align-self:flex-start;max-width:100%}.osm-pg-n{color:#8fb4ff}
.osm-pg-inner{position:relative;max-width:none;background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.4);border-radius:3px}.osm-pg-inner img{width:100%;display:block;user-select:none}.osm-ink{position:absolute;inset:0;width:100%;height:100%;touch-action:none}
.osm-side{width:470px;max-width:48vw;background:var(--osm-card);color:var(--osm-fg);border-left:1px solid var(--osm-line);display:flex;flex-direction:column;min-height:0}
.osm-score{padding:8px 14px 6px;border-bottom:1px solid var(--osm-line)}.osm-score-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px}.osm-score-num{font-size:1.45rem;font-weight:700;line-height:1.1;background:var(--osm-grad);-webkit-background-clip:text;background-clip:text;color:transparent}.osm-score-num small{font-size:.8rem;font-weight:500;color:var(--osm-muted);-webkit-text-fill-color:var(--osm-muted)}
.osm-bar{height:5px;background:var(--osm-line);border-radius:5px;margin:6px 0 0;overflow:hidden}.osm-bar i{display:block;height:100%;background:var(--osm-grad);transition:width .25s}
.osm-save{font-size:.74rem}.osm-save.ok{color:var(--osm-ok)}.osm-save.bad{color:var(--osm-bad)}
.osm-unlock{padding:6px 14px;font-size:.76rem;color:var(--osm-muted);display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--osm-line)}
.osm-qwrap{flex:1;display:flex;min-height:0}
.osm-rail{width:54px;flex:none;overflow:auto;padding:6px 5px;border-right:1px solid var(--osm-line);display:flex;flex-direction:column;gap:4px;background:var(--osm-soft)}
.osm-rb{border:1.5px solid var(--c);background:transparent;color:var(--c);border-radius:8px;height:26px;min-height:26px;font-size:.7rem;font-weight:700;cursor:pointer;font-family:inherit;padding:0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.osm-rb.has{background:var(--c);color:#fff}.osm-rb:hover{filter:brightness(.92);transform:scale(1.05)}
.osm-qs{flex:1;overflow:auto;padding:6px 8px 10px;scroll-behavior:auto}
.osm-q{border:1px solid var(--osm-line);border-left:4px solid var(--c,#b8c0d0);border-radius:10px;padding:5px 8px 6px;margin:5px 0;background:var(--osm-card)}.osm-q.has{background:color-mix(in srgb,var(--c) 8%,var(--osm-card))}.osm-q.other{opacity:.65}.osm-q.loser{opacity:.55}.osm-q.flash{box-shadow:0 0 0 3px #f5a623}
.osm-q-row{display:flex;gap:5px;align-items:center}.osm-qh{display:flex;align-items:baseline;gap:4px;min-width:62px;flex:1}.osm-qn{font-weight:700;font-size:.92rem;color:var(--c)}.osm-max{font-size:.72rem;color:var(--osm-muted)}
.osm-tag{font-size:.6rem;padding:0 6px;border-radius:99px;background:#ece6f7;color:#5b3fa0}.osm-tag.mine{background:#d9f3e6;color:var(--osm-ok)}
#osm-root .osm-in{width:62px;max-width:62px;min-width:0;flex:none;margin:0;font-size:1.05rem;font-weight:700;text-align:center;padding:2px;height:30px;border:2px solid var(--c,#b8c0d0);border-radius:9px;background:var(--osm-bg);color:var(--osm-fg);font-family:inherit}.osm-in:focus{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--c,#2575fc) 30%,transparent)}.osm-in:disabled{background:transparent;border-style:dashed}
.osm-mini{height:30px;padding:0 9px;min-width:32px;border:1px solid var(--osm-line);background:var(--osm-card);color:var(--osm-fg);border-radius:9px;cursor:pointer;font-size:.8rem;font-family:inherit;font-weight:600}.osm-mini.step{font-size:1.15rem;line-height:1;min-width:30px;padding:0}.osm-mini.full{background:var(--osm-soft);color:var(--osm-accent)}.osm-mini:hover:not(:disabled){background:var(--osm-soft);border-color:var(--osm-accent)}.osm-mini:disabled{opacity:.35}
.osm-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.osm-cv{min-width:31px;height:25px;padding:0 5px;border:1.5px solid var(--c);background:color-mix(in srgb,var(--c) 9%,transparent);color:var(--c);border-radius:8px;cursor:pointer;font-size:.74rem;font-weight:700;font-family:inherit}.osm-cv:hover:not(:disabled){background:color-mix(in srgb,var(--c) 22%,transparent)}.osm-cv.sel{background:var(--c);color:#fff;box-shadow:0 2px 6px color-mix(in srgb,var(--c) 45%,transparent)}.osm-cv:disabled{opacity:.35}
.osm-by{font-size:.7rem;color:var(--osm-muted);margin-top:4px}
.osm-steps{display:flex;gap:8px;align-items:center;margin:0 0 12px;font-size:.8rem;color:var(--osm-muted);flex-wrap:wrap}.osm-steps span{padding:4px 12px;border-radius:99px;border:1px solid var(--osm-line);background:var(--osm-card)}.osm-steps span.cur{border-color:var(--osm-accent);color:var(--osm-accent);font-weight:600}.osm-steps span.done{background:#d9f3e6;color:var(--osm-ok);border-color:#b8e6cd}
.osm-tabs{display:flex;gap:6px;padding:8px 12px 0}.osm-tabs button{flex:1;border:1px solid var(--osm-line);background:var(--osm-card);color:var(--osm-fg);border-radius:10px 10px 0 0;padding:8px;font-family:inherit;font-size:.84rem;font-weight:600;cursor:pointer}.osm-tabs button.on{background:var(--osm-grad);color:#fff;border-color:transparent}
.osm-pubrow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px}
.osm-badge.analysed{background:#dbe8ff;color:#2575fc}.osm-badge.published{background:#d9f3e6;color:var(--osm-ok)}
.osm-banner.info{background:#e8f0ff;color:#2575fc}.osm-act{white-space:nowrap}.osm-act .osm-btn,.osm-act .osm-link{margin-right:5px}
.osm-markbtn{padding:10px 26px;font-size:1rem;font-weight:600;border-radius:12px;min-width:96px;justify-content:center}.osm-act{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.osm-fbhead{padding:10px 14px 8px;border-bottom:1px solid var(--osm-line)}.osm-fbscore{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}.osm-fbbig{font-size:1.9rem;font-weight:700;line-height:1.1;background:var(--osm-grad);-webkit-background-clip:text;background-clip:text;color:transparent}.osm-fbof{font-size:.9rem;color:var(--osm-muted)}.osm-grade{margin-left:auto;color:#fff;font-size:.74rem;font-weight:700;padding:3px 11px;border-radius:99px}
.osm-fbscroll{flex:1;overflow:auto;padding:8px 10px 14px}
.osm-rq{border:1px solid var(--osm-line);border-radius:14px;padding:9px 12px;margin:8px 0;background:var(--osm-card);border-left:5px solid #b8c0d0}.osm-rq.full{border-left-color:#1e8e4e}.osm-rq.part{border-left-color:#d17a0a}.osm-rq.zero{border-left-color:#d12f3a}.osm-rq.gray{opacity:.6}
.osm-rq-h{display:flex;align-items:center;gap:8px}.osm-rq-n{font-size:1.05rem;font-weight:700;color:#1a1f6e}.osm-rq-chip{margin-left:auto;font-size:.82rem;color:var(--osm-muted)}
.osm-rq.full .osm-fbmark{color:#1e8e4e;background:#e8f6ee;border-color:#b8e0cb}.osm-rq.part .osm-fbmark{color:#d17a0a;background:#fff3e0;border-color:#f3d9a4}.osm-rq.zero .osm-fbmark{color:#d12f3a;background:#fdeaec;border-color:#f2b9bf}
.osm-rbox{border-radius:10px;padding:8px 11px;margin-top:8px;font-size:.82rem;line-height:1.5}.osm-rbox.blue{background:#e8f0ff}.osm-rbox.amber{background:#fff6df}.osm-rlab{font-size:.62rem;letter-spacing:1.1px;font-weight:700;color:#2a4fb0;margin-bottom:2px}.osm-rbox.amber .osm-rlab{color:#a8700a}
.osm-ok{font-size:.78rem;font-weight:600;color:#1e8e4e}.osm-rq.compact{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:5px 12px}.osm-rq.compact .osm-rq-h{flex:1}.osm-rq.compact .osm-rq-foot{margin:0}.osm-rq.compact .osm-sol,.osm-rq.compact .osm-rq-view{display:none}.osm-rq.compact .osm-rq-edit{flex-basis:100%}
.osm-rq-edit label{display:block;font-size:.72rem;font-weight:600;margin:8px 0 3px;color:var(--osm-fg)}.osm-rq-edit small{font-weight:400;color:var(--osm-muted)}
.osm-rq-foot{display:flex;align-items:center;gap:12px;margin-top:6px;flex-wrap:wrap}.osm-sol{font-size:.76rem;color:var(--osm-muted)}.osm-sol summary{cursor:pointer}.osm-sol div{margin-top:4px;padding:7px 10px;background:#efeafc;color:#34286a;border-radius:9px;line-height:1.45}
.osm-ovtitle{font-size:.72rem;letter-spacing:1.4px;font-weight:700;color:#1a1f6e;margin-bottom:8px}.osm-win{background:#efeafc;border:1px solid #d9d0f5;border-radius:14px;padding:12px 16px;font-size:.9rem;margin-bottom:10px}.osm-win b{font-size:1.9rem;color:#5b3fa0;margin-right:6px}
.osm-bars{margin-top:4px}.osm-bar2{display:flex;align-items:center;gap:8px;margin:7px 0;font-size:.78rem}.osm-bl{width:40%;font-weight:600;line-height:1.25}.osm-bt{flex:1;height:9px;background:var(--osm-line);border-radius:8px;overflow:hidden}.osm-bt i{display:block;height:100%;border-radius:8px}.osm-bar2 b{width:62px;text-align:right}
.osm-pill{display:inline-block;margin:3px 5px 3px 0;padding:5px 11px;border-radius:99px;font-size:.76rem;font-weight:600;border:1.5px solid}.osm-pill.g{background:#eaf7ef;border-color:#1e8e4e;color:#17613a}.osm-pill.a{background:#fff4e2;border-color:#d17a0a;color:#8a4f00}
.osm-step{display:flex;gap:10px;align-items:center;border:1px solid var(--osm-line);border-radius:99px;padding:7px 14px;margin:6px 0;font-size:.8rem}.osm-step b{width:22px;height:22px;border-radius:50%;background:#e1f4e8;color:#1e8e4e;display:flex;align-items:center;justify-content:center;flex:none;font-size:.74rem}
.osm-fq{border:1px solid var(--osm-line);border-left:4px solid var(--c,#b8c0d0);border-radius:10px;padding:7px 10px;margin:6px 0;background:var(--osm-card)}.osm-fq.loser{opacity:.6}
.osm-fq-head{display:flex;align-items:center;gap:8px}.osm-fq-marks{margin-left:auto;font-size:.82rem;color:var(--osm-muted)}
#osm-root .osm-fbmark{width:52px;text-align:center;font-weight:700;border:1.5px solid var(--c);border-radius:8px;padding:2px;font-family:inherit;background:var(--osm-bg);color:var(--osm-fg)}
.osm-fbtext{margin:6px 0 2px;font-size:.82rem;line-height:1.5}
#osm-root .osm-fbta,#osm-root .osm-ovta{width:100%;margin-top:6px;border:1px solid var(--osm-accent);border-radius:9px;padding:7px 9px;font-family:inherit;font-size:.82rem;line-height:1.45;resize:vertical;background:var(--osm-bg);color:var(--osm-fg)}
.osm-ov{margin-top:14px;padding-top:10px;border-top:2px solid var(--osm-line)}.osm-ov h4{margin:0 0 6px;font-size:1rem}.osm-ovb{margin:10px 0}.osm-ovh{display:flex;justify-content:space-between;align-items:center}.osm-ovtext{font-size:.83rem;line-height:1.5;margin-top:3px}.osm-ovtext ul{margin:2px 0 0 16px;padding:0}
.osm-cmt{width:100%;border-collapse:collapse;font-size:.8rem}.osm-cmt td{padding:4px 4px;border-bottom:1px solid var(--osm-line)}.osm-cmbar{height:7px;background:var(--osm-line);border-radius:6px;overflow:hidden}.osm-cmbar i{display:block;height:100%}.osm-cmlv{font-size:.68rem;font-weight:700;color:#fff;padding:2px 8px;border-radius:99px;white-space:nowrap}
.osm-flags{margin-top:10px;padding:8px 10px;border-radius:9px;background:#fff6e5;border:1px solid #f3d9a4;font-size:.76rem;color:#7a5200}.osm-flags ul{margin:4px 0 0 16px;padding:0}
.osm-rbtn{width:28px;height:30px;flex:none;border:1px dashed var(--osm-line);background:transparent;color:var(--osm-muted);border-radius:9px;cursor:pointer;font-size:.85rem;padding:0}.osm-rbtn:hover:not(:disabled){border-color:var(--osm-accent);color:var(--osm-accent)}.osm-rbtn.has{background:var(--osm-accent);color:#fff;border-style:solid;border-color:var(--osm-accent)}
#osm-root .osm-reason{width:100%;margin-top:6px;border:1px solid var(--osm-line);border-radius:9px;padding:6px 9px;font-family:inherit;font-size:.8rem;line-height:1.4;resize:vertical;background:var(--osm-bg);color:var(--osm-fg)}#osm-root .osm-reason:focus{outline:none;border-color:var(--osm-accent)}
.osm-note-edit{position:absolute;z-index:4;max-height:110px;overflow-y:auto;box-sizing:border-box;background:rgba(255,255,255,.97);border:2px solid #2575fc;border-radius:8px;padding:4px 8px;font-family:'Poppins',system-ui,sans-serif;font-weight:600;line-height:1.3;resize:none;outline:none;box-shadow:0 4px 14px rgba(0,0,0,.3)}
.osm-det{margin-top:5px;font-size:.8rem}.osm-det summary{cursor:pointer;color:var(--osm-muted)}.osm-qtext,.osm-ans,.osm-ci{margin-top:6px;line-height:1.5;white-space:pre-wrap}.osm-ci{color:var(--osm-muted);font-size:.8rem}
.osm-foot{border-top:1px solid var(--osm-line);padding:10px 12px;display:flex;flex-direction:column;gap:7px}.osm-doneline{display:flex;flex-wrap:wrap;gap:3px}.osm-doneline .osm-chip{font-size:.7rem;padding:1px 7px;margin-right:0}.osm-nav{display:flex;justify-content:space-between;gap:8px}
#osm-toasts{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9950;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;font-family:'Poppins',system-ui,sans-serif}
.osm-toast{background:#2b3040;color:#fff;padding:11px 18px;border-radius:14px;font-size:.88rem;box-shadow:0 8px 30px rgba(0,0,0,.35);max-width:min(560px,92vw)}.osm-toast.error{background:#c0392b}.osm-toast.success{background:#1e9e5a}
#osm-busy{position:fixed;inset:0;z-index:9900;background:rgba(245,247,250,.82);display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:center;font-family:'Poppins',system-ui,sans-serif;color:#34495e;font-weight:500}
@media (max-width:900px){.osm-side{width:340px}.osm-kpis{display:none}}

/* ───────── v2 polish: modern type, compact density, consistent buttons ───────── */
#osm-root,.osm-modal,#osm-toasts,#osm-busy{font-family:'Inter','Poppins',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;letter-spacing:-.006em}
#osm-root{font-size:13px;--osm-line:#e6eaf2;--osm-bg:#f6f8fc;--osm-soft:#f0f4ff;--osm-fg:#1f2937;--osm-muted:#6b7280}
.osm-ic{flex:none}
.osm-btn{height:34px;padding:0 14px;border-radius:10px;font-size:12.5px;font-weight:600;gap:7px;border:1px solid #dfe5f0;background:#fff;color:#1f2937;box-shadow:0 1px 1px rgba(16,24,40,.04);transition:background .15s,box-shadow .15s,transform .05s,border-color .15s}
.osm-btn:hover{background:#f3f6fd;border-color:#c9d6f3}.osm-btn:active{transform:translateY(1px)}.osm-btn:focus-visible{outline:2px solid #2575fc;outline-offset:2px}
.osm-btn.small{height:30px;padding:0 11px;font-size:12px;border-radius:9px}.osm-btn.tiny{height:26px;padding:0 9px;font-size:11.5px;border-radius:8px;gap:5px}.osm-btn.tiny .osm-ic{width:13px;height:13px}
.osm-btn.primary{background:linear-gradient(135deg,#2f7bff,#6a3df0);border-color:transparent;color:#fff;box-shadow:0 1px 2px rgba(60,60,200,.25),0 6px 14px rgba(70,70,230,.22)}.osm-btn.primary:hover{filter:brightness(1.06);background:linear-gradient(135deg,#2f7bff,#6a3df0)}
.osm-btn.soft{background:#eef3ff;border-color:#d6e2ff;color:#2552c9}.osm-btn.soft:hover{background:#e3ecff}
.osm-btn.outline{background:#fff;border-color:#2f7bff;color:#2f6bf0}.osm-btn.outline:hover{background:#f0f5ff}
.osm-btn.quiet{background:transparent;border-color:transparent;color:#6b7280;box-shadow:none}.osm-btn.quiet:hover{background:#f3f4f6;color:#b42318}
.osm-btn.ghost{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.28);color:#fff;box-shadow:none}.osm-btn.ghost:hover{background:rgba(255,255,255,.26)}
.osm-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.osm-top,.osm-desk-top{padding:10px 20px}.osm-title{font-size:15px;font-weight:600}.osm-top .osm-sub,.osm-desk-top .osm-sub{font-size:12px}
.osm-body{padding:18px 20px 50px}
.osm-kpi{border-radius:12px;padding:8px 16px;box-shadow:0 1px 2px rgba(16,24,40,.05)}.osm-kpi b{font-size:1.25rem;font-weight:700}.osm-kpi span{font-size:.7rem}
.osm-table-wrap{border-radius:14px;box-shadow:0 1px 2px rgba(16,24,40,.05),0 8px 24px rgba(37,117,252,.05)}
.osm-table{font-size:12.5px}.osm-table th{font-size:10.5px;letter-spacing:.06em;font-weight:600;padding:9px 14px}.osm-table td{padding:9px 14px}.osm-nm{font-weight:600}
.osm-badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;font-size:11px;font-weight:600}.osm-badge i{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.85}
.osm-chip{font-size:10.5px;padding:2px 8px}
button.osm-link{font-size:11.5px}
.osm-act{display:flex;align-items:center;gap:7px;flex-wrap:nowrap;white-space:nowrap}.osm-table td:nth-child(4){white-space:nowrap}.osm-markbtn{height:36px;min-width:92px;justify-content:center;padding:0 18px;font-size:13px;border-radius:11px}
/* desk toolbar + tabs */
.osm-seg button{font-size:12px;padding:6px 11px;display:inline-flex;align-items:center;gap:5px}.osm-seg button .osm-ic{width:13px;height:13px}
.osm-tabs{padding:10px 12px 0;gap:4px;background:var(--osm-card)}.osm-tabs button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:9px 9px 0 0;padding:8px;font-size:12.5px;font-weight:600;color:#6b7280;background:#f3f4f8;border:1px solid var(--osm-line);border-bottom:0}.osm-tabs button.on{background:#fff;color:#2552c9;box-shadow:inset 0 2px 0 #2f7bff}
.osm-nav .osm-btn{flex:1;justify-content:center}
/* feedback panel */
.osm-fbhead{padding:12px 14px 10px;background:#fff;border-bottom:1px solid var(--osm-line)}
.osm-fbtop{display:flex;align-items:center;justify-content:space-between;gap:10px}.osm-fbscore{display:flex;align-items:baseline;gap:6px}.osm-fbbig{font-size:1.7rem;font-weight:700;letter-spacing:-.03em}.osm-fbof{font-size:.85rem;color:#9ca3af;font-weight:500}
.osm-grade{margin:0;font-size:.7rem;padding:4px 11px;letter-spacing:0}
.osm-fbstat{display:flex;align-items:center;gap:10px;margin-top:6px;flex-wrap:wrap}
.osm-fbacts{display:flex;gap:7px;margin-top:10px;flex-wrap:wrap}.osm-fbacts .osm-btn.primary{flex:1;justify-content:center;min-width:110px}
.osm-hint{margin-top:8px;font-size:11.5px;color:#92600a;background:#fff7e6;border-radius:8px;padding:6px 10px}
.osm-fbbar{padding:8px 12px;background:#fff;border-bottom:1px solid var(--osm-line)}
.osm-seg2{display:flex;background:#f0f2f7;border-radius:10px;padding:3px;gap:3px}.osm-seg2 button{flex:1;border:0;background:transparent;border-radius:8px;padding:6px 8px;font-family:inherit;font-size:12px;font-weight:600;color:#6b7280;cursor:pointer}.osm-seg2 button b{margin-left:4px;font-weight:700;color:#9ca3af}.osm-seg2 button.on{background:#fff;color:#1f2937;box-shadow:0 1px 3px rgba(16,24,40,.12)}.osm-seg2 button.on b{color:#2f6bf0}
.osm-fbscroll{padding:10px 12px 16px;background:var(--osm-bg)}
.osm-fbscroll[data-f="lost"] .osm-rq.full,.osm-fbscroll[data-f="lost"] .osm-rq.gray{display:none}
.osm-qmap{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px}.osm-qm{min-width:30px;height:24px;padding:0 6px;border-radius:7px;border:1.5px solid;background:#fff;font-family:inherit;font-size:10.5px;font-weight:700;cursor:pointer}.osm-qm.full{border-color:#b9e3c8;color:#1e8e4e;background:#eefaf2}.osm-qm.part{border-color:#f4d7a3;color:#b8650a;background:#fff6e6}.osm-qm.zero{border-color:#f3b8bd;color:#c42b36;background:#fdecee}.osm-qm.gray{border-color:#e5e7eb;color:#9ca3af;background:#f8f9fb}.osm-qm:hover{filter:brightness(.96)}
.osm-rq{border-radius:12px;padding:10px 12px;margin:7px 0;box-shadow:0 1px 2px rgba(16,24,40,.05);border:1px solid var(--osm-line);border-left-width:4px}.osm-rq.flash{box-shadow:0 0 0 3px #fbbf24}
.osm-rq-n{font-size:13.5px;font-weight:700;letter-spacing:-.01em}.osm-rq-chip{font-size:11.5px}
#osm-root .osm-fbmark{width:46px;font-size:12.5px;border-radius:8px}
.osm-rbox{font-size:12px;line-height:1.55;border-radius:9px;padding:8px 11px}.osm-rlab{font-size:9.5px;letter-spacing:.08em}
.osm-rq-foot{margin-top:8px;gap:8px}.osm-sol{font-size:11.5px}
.osm-rq-edit label{font-size:11px;margin:8px 0 3px;font-weight:600}
#osm-root .osm-fbta,#osm-root .osm-ovta{font-size:12.5px;border-radius:9px;border-color:#c9d6f3}
.osm-rq.compact{padding:6px 12px}
.osm-ov{margin-top:16px;padding-top:12px;border-top:1px solid var(--osm-line)}.osm-ovtitle{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#6b7280;font-weight:700;margin-bottom:8px}
.osm-win{display:flex;align-items:baseline;gap:8px;background:linear-gradient(135deg,#f1ecff,#eaf1ff);border:1px solid #ddd6fb;border-radius:12px;padding:10px 14px;margin-bottom:10px;font-size:12px;color:#4b5563}.osm-win b{font-size:1.6rem;color:#5b3fa0;letter-spacing:-.02em}
.osm-ovb{background:#fff;border:1px solid var(--osm-line);border-radius:12px;padding:10px 12px;margin:8px 0}.osm-ovh{display:flex;justify-content:space-between;align-items:center;gap:8px}.osm-ovh b{font-size:12.5px;font-weight:700}.osm-ovh .osm-muted{font-size:10.5px}
.osm-ovtext{font-size:12.5px;margin-top:6px}
.osm-bar2{font-size:11.5px;margin:6px 0}.osm-bt{height:7px}
.osm-pill{font-size:11px;padding:4px 10px;border-width:1px}.osm-step{font-size:12px;padding:6px 12px}
.osm-flags{border-radius:12px;font-size:11.5px}
.osm-foot{padding:10px 12px;background:#fff;border-top:1px solid var(--osm-line)}
/* marking panel */
.osm-q{border-radius:11px}.osm-score-num{font-size:1.3rem}

/* question cards: yours are bright and clearly editable, other teachers' are faded; compact 3-line layout */
#osm-root .osm-q{background:#fff;border:1px solid #e1e7f2;border-left:4px solid var(--c,#b8c0d0);border-radius:12px;box-shadow:0 1px 2px rgba(20,30,60,.05);padding:5px 9px 6px!important}
#osm-root .osm-q.has{background:color-mix(in srgb,var(--c) 7%,#fff)}
#osm-root .osm-q:not(.has):not(.other):not(.na){border-left-color:#2575fc;box-shadow:0 1px 4px rgba(37,117,252,.16)}
#osm-root .osm-q:not(.has):not(.other):not(.na) .osm-qn{color:#1c3f9e}
#osm-root .osm-q.other{opacity:.5;background:#f2f4f8;border-left-color:#c8cedb;box-shadow:none}
#osm-root .osm-qtop{display:flex;align-items:center;gap:6px;min-height:22px}
#osm-root .osm-qtop .osm-qn{font-size:1rem;letter-spacing:-.01em}
#osm-root .osm-qtop .osm-nab{height:22px!important;min-height:0!important;padding:0 10px!important;border-radius:99px!important;font-size:.68rem!important;font-weight:600;background:#fff!important;color:#6b7280!important;border:1px solid #d3d9e6!important;box-shadow:none!important;white-space:nowrap}
#osm-root .osm-qtop .osm-nab:hover:not(:disabled){background:#f1f3f8!important;color:#374151!important}
#osm-root .osm-qtop .osm-nab.on{background:#6b7280!important;color:#fff!important;border-color:#6b7280!important}
#osm-root .osm-qstep{display:flex;align-items:center;gap:6px;margin-top:4px;justify-content:flex-start}
#osm-root .osm-qstep .osm-mini.step{width:30px;height:30px;padding:0;border-radius:9px;font-size:1.05rem;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
#osm-root .osm-qstep .osm-in{width:62px;height:30px;text-align:center;font-size:1rem;font-weight:700;border-radius:9px}
#osm-root .osm-qstep .osm-mini.full{height:30px;padding:0 12px;border-radius:99px;font-size:.76rem;font-weight:700;background:#e7f6ee;color:#1c7c46;border:1px solid #bfe5d0}
#osm-root .osm-qstep .osm-mini.full:hover:not(:disabled){background:#d4f0e1}
#osm-root .osm-chiprow{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:5px!important}
#osm-root .osm-chiprow .osm-by{margin:0 4px 0 2px!important;font-size:.68rem!important;white-space:nowrap}
#osm-root .osm-chiprow .osm-rbtn{margin:0 0 0 auto!important;width:auto!important;min-height:0!important;height:22px!important;padding:0 9px!important;font-size:.68rem!important;font-weight:600;border-width:1px!important;border-radius:99px!important;display:inline-flex!important;align-items:center;gap:4px}
#osm-root .osm-chiprow .osm-rbtn svg{width:11px!important;height:11px!important}#osm-root .osm-chiprow .osm-rbtn em{display:none}
#osm-root .osm-tag.owner{background:#e9edf5;color:#3b4a66;font-weight:600;border:1px solid #d3d9e6}#osm-root .osm-tag.mine{font-weight:700}
#osm-root .osm-qtop .osm-nab.on{background:#3b8bea!important;color:#fff!important;border-color:#3b8bea!important}
#osm-root .osm-orwarn{display:none}#osm-root .osm-orw{background:#fff1e6;border:1.5px solid #f08a24;color:#7a3a00;border-radius:10px;padding:6px 10px;font-size:.76rem;line-height:1.4;margin-bottom:5px}
#osm-root .osm-orgo{display:inline-flex;gap:5px;margin-left:4px}#osm-root .osm-orgo button{border:1px solid #f08a24;background:#fff;color:#7a3a00;border-radius:99px;padding:1px 8px;font-size:.7rem;font-weight:600;cursor:pointer}#osm-root .osm-orgo button:hover{background:#ffe3cc}
`;
    document.head.appendChild(s);
}
