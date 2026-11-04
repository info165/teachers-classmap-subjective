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
}

let B: OsmBridge;
export function initOsm(bridge: OsmBridge) { B = bridge; injectStyle(); }

// ───────────────────────── types ─────────────────────────
interface Paper {
    owner: string; id: string; title: string; className: string; section: string; subject: string; stream: string;
    totalMarks: number; questions: any[]; created: string; schoolName: string;
}
interface Roster { id: string; className: string; section: string; subject: string; stream?: string; schoolName: string; students: any[]; board?: string; teacherUid: string }
interface StuDoc { studentUid: string; studentName: string; rollNumber: string; pages?: { url: string; path: string }[]; marks?: Record<string, { v: number; by: string; n: string; t: number }>; done?: Record<string, { n: string; t: number }>; }
interface Meta { assign?: Record<string, number[]>; readyForAnalysis?: boolean; }

const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const qk = (i: number) => `q${i}`;
const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const qMax = (q: any) => Number(q?.marks) || 0;
const shortName = (name: string, all: { name: string }[]) => { const w = name.split(' '); for (let k = 1; k <= w.length; k++) { const c = w.slice(0, k).join(' '); if (all.filter(a => a.name.startsWith(c + ' ') || a.name === c).length === 1) return c; } return name; };
const fmt1 = (n: number) => (Math.round(n * 100) / 100).toString();

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
async function expectedTeachers(r: Roster): Promise<{ uid: string; name: string }[]> {
    const snap = await B.db.collection('classRosters')
        .where('className', '==', r.className).where('section', '==', r.section)
        .where('subject', '==', r.subject).where('schoolName', '==', r.schoolName).get();
    const out: { uid: string; name: string }[] = [];
    snap.docs.forEach((d: any) => {
        const x = d.data();
        if ((x.stream || '') !== (r.stream || '')) return;
        if (!out.some(o => o.uid === x.teacherUid)) out.push({ uid: x.teacherUid, name: x.teacherName || x.teacherUid });
    });
    return out;
}

async function loadPapers(r: Roster, teachers: { uid: string; name: string }[]): Promise<Paper[]> {
    const all: Paper[] = [];
    const uids = teachers.map(t => t.uid);
    const me = B.teacher()!.uid;
    if (!uids.includes(me)) uids.push(me);
    await Promise.all(uids.map(async uid => {
        try {
            const snap = await B.db.collection('teachers').doc(uid).collection('assessmentHistory').where('assessmentMode', '==', 'osm').get();
            snap.docs.forEach((d: any) => {
                const x = d.data();
                if (String(x.className) !== String(r.className) || x.section !== r.section || x.subject !== r.subject) return;
                if ((x.stream || '') !== (r.stream || '')) return;
                all.push({
                    owner: uid, id: d.id, title: x.assessmentTitle || 'Untitled', className: x.className, section: x.section,
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

function studentState(paper: Paper, s: StuDoc | undefined, meta: Meta, teachers: { uid: string; name: string }[]) {
    if (!s || !s.pages?.length) return { code: 'nosheet', label: 'No sheet', ready: false, doneBy: [] as string[], needBy: [] as string[] };
    const sc = scoreFor(paper, s.marks);
    const contributors = new Set<string>(Object.values(s.marks || {}).map(m => m.by));
    const assigned = Object.entries(meta.assign || {}).filter(([, a]) => a?.length).map(([u]) => u);
    const need = [...new Set([...assigned, ...contributors])];
    const doneBy = Object.keys(s.done || {});
    const allMarked = sc.marked >= sc.count && sc.count > 0;
    const ready = allMarked && need.length > 0 && need.every(u => doneBy.includes(u));
    const nameOf = (u: string) => teachers.find(t => t.uid === u)?.name || u;
    if (ready) return { code: 'ready', label: 'Ready for analysis', ready, doneBy, needBy: [] };
    if (sc.marked === 0) return { code: 'new', label: 'Not started', ready, doneBy, needBy: need.map(nameOf) };
    return { code: 'prog', label: `In progress · ${sc.marked}/${sc.count}`, ready, doneBy, needBy: need.filter(u => !doneBy.includes(u)).map(nameOf) };
}

// ───────────────────────── SCREEN A: home ─────────────────────────
export async function openOsmHome(roster: Roster) {
    const el = ensureRoot();
    clearListeners();
    el.innerHTML = shell(`Teacher Marking`, `Class ${esc(roster.className)}–${esc(roster.section)} · ${esc(roster.subject)}${roster.stream ? ' · ' + esc(roster.stream) : ''}`,
        `<div class="osm-center"><div class="osm-spin"></div></div>`);
    wireClose(el);
    try {
        const teachers = await expectedTeachers(roster);
        const papers = await loadPapers(roster, teachers);
        const body = el.querySelector('.osm-body') as HTMLElement;
        body.innerHTML = `
          <div class="osm-toolbar"><h2>Question papers</h2><button class="osm-btn primary" id="osm-new">＋ New paper</button></div>
          ${papers.length === 0 ? `<div class="osm-empty"><p>No papers yet.</p><p class="osm-sub">Create a question paper (Excel), upload each student's answer sheet, then mark it on screen. Your co-teachers see the same papers and marks.</p></div>` :
            `<div class="osm-grid">${papers.map(p => `
              <button class="osm-card" data-id="${esc(p.id)}">
                <div class="osm-card-title">${esc(p.title)}</div>
                <div class="osm-sub">${p.questions.length} questions · ${declaredTotal(p) || '—'} marks</div>
                <div class="osm-sub">Created ${p.created ? new Date(p.created).toLocaleDateString() : ''}</div>
              </button>`).join('')}</div>`}
          <p class="osm-sub osm-teachers">Teachers on this class: ${teachers.map(t => esc(t.name)).join(', ') || '—'}</p>`;
        body.querySelector('#osm-new')!.addEventListener('click', () => openCreatePaper(roster, teachers));
        body.querySelectorAll<HTMLElement>('.osm-card').forEach(c => c.addEventListener('click', () => {
            const p = papers.find(x => x.id === c.dataset.id)!;
            openPaperRoster(roster, p, teachers);
        }));
    } catch (e: any) {
        console.error('[osm] home failed', e);
        (el.querySelector('.osm-body') as HTMLElement).innerHTML = `<div class="osm-empty"><p>Could not load papers.</p><p class="osm-sub">${esc(e?.message)}</p></div>`;
    }
}

function shell(title: string, sub: string, bodyHtml: string, backLabel = 'Back to class') {
    return `<div class="osm-top">
        <button class="osm-btn ghost" id="osm-close">← ${esc(backLabel)}</button>
        <div class="osm-titlebox"><div class="osm-title">${esc(title)}</div><div class="osm-sub">${sub}</div></div>
        <div class="osm-top-right"></div></div>
      <div class="osm-body">${bodyHtml}</div>`;
}
function wireClose(el: HTMLElement, fn?: () => void) {
    el.querySelector('#osm-close')?.addEventListener('click', fn || (() => { closeOsm(); B.backToClass(); }));
}

// ───────────────────────── create paper ─────────────────────────
function openCreatePaper(roster: Roster, teachers: { uid: string; name: string }[]) {
    const el = ensureRoot();
    el.innerHTML = shell('New question paper', `Class ${esc(roster.className)}–${esc(roster.section)} · ${esc(roster.subject)}`, `
      <div class="osm-form">
        <label>Paper title<input id="osm-np-title" placeholder="e.g. Half-Yearly Examination"></label>
        <label>Total marks (declared on the paper)<input id="osm-np-total" type="number" min="1" step="1" placeholder="e.g. 80"></label>
        <label>Question paper Excel<input id="osm-np-file" type="file" accept=".xlsx,.xls"></label>
        <p class="osm-sub">Same Excel template as Exams. The total marks you type here is the paper's total — it is <b>never</b> re-added from the questions, because alternative (OR) questions add extra marks that students don't attempt.</p>
        <div id="osm-np-preview"></div>
        <div class="osm-actions"><button class="osm-btn primary" id="osm-np-save" disabled>Save paper</button></div>
      </div>`, 'Back to papers');
    wireClose(el, () => openOsmHome(roster));
    let questions: any[] = [];
    const fileEl = el.querySelector('#osm-np-file') as HTMLInputElement;
    const saveBtn = el.querySelector('#osm-np-save') as HTMLButtonElement;
    const prev = el.querySelector('#osm-np-preview') as HTMLElement;
    fileEl.addEventListener('change', async () => {
        const f = fileEl.files?.[0]; if (!f) return;
        B.loading(true, 'Reading Excel…');
        try {
            questions = await B.parseExcel(f);
            if (!questions.length) { B.toast('No questions found in that Excel.', 'error'); saveBtn.disabled = true; return; }
            const sum = questions.reduce((s, q) => s + qMax(q), 0);
            prev.innerHTML = `<div class="osm-note">${questions.length} questions read. Sum of every question's marks = <b>${fmt1(sum)}</b> (includes alternative OR questions). The declared total above will be used for results.</div>
              <div class="osm-qtable"><table><thead><tr><th>Q</th><th>Question</th><th>Type</th><th>Marks</th></tr></thead><tbody>
              ${questions.map((q, i) => `<tr><td>${esc(q.questionNumber || i + 1)}</td><td>${esc(String(q.text || '').slice(0, 110))}</td><td>${esc(q.type || '')}</td><td>${fmt1(qMax(q))}</td></tr>`).join('')}
              </tbody></table></div>`;
            saveBtn.disabled = false;
        } catch (e: any) { B.toast('Could not read Excel: ' + e.message, 'error'); saveBtn.disabled = true; }
        finally { B.loading(false); }
    });
    saveBtn.addEventListener('click', async () => {
        const title = (el.querySelector('#osm-np-title') as HTMLInputElement).value.trim();
        const total = Number((el.querySelector('#osm-np-total') as HTMLInputElement).value);
        if (!title) return B.toast('Please enter the paper title.', 'error');
        if (!(total > 0)) return B.toast('Please enter the total marks for the paper.', 'error');
        if (!questions.length) return B.toast('Upload the question paper Excel first.', 'error');
        // Never create a second paper with the same title for this class (co-teachers share one paper).
        const existing = await loadPapers(roster, teachers);
        if (existing.some(p => norm(p.title) === norm(title))) return B.toast('A paper with this title already exists for this class — open it from the list.', 'error');
        const t = B.teacher()!;
        const id = B.db.collection('teachers').doc(t.uid).collection('assessmentHistory').doc().id;
        const clean = JSON.parse(JSON.stringify(questions, (_k, v) => v === undefined ? null : v));
        saveBtn.disabled = true; B.loading(true, 'Saving paper…');
        try {
            await paperRef(t.uid, id).set({
                assessmentId: id, assessmentMode: 'osm', createdByTeacherUid: t.uid, teacherName: t.name, schoolName: roster.schoolName,
                board: roster.board || t.board || '', subject: roster.subject, className: roster.className, section: roster.section, stream: roster.stream || '',
                assessmentTitle: title, questions: clean, totalMarks: total, creationTimestamp: new Date().toISOString(),
                source: 'question_images', difficultyLevel: '', checkingStrictness: 'Moderate', selectedChapters: [], topics: [], generalInstructions: '',
            });
            B.toast('Paper saved.', 'success');
            openOsmHome(roster);
        } catch (e: any) { B.toast('Could not save paper: ' + e.message, 'error'); saveBtn.disabled = false; }
        finally { B.loading(false); }
    });
}

// ───────────────────────── SCREEN B: paper roster ─────────────────────────
async function openPaperRoster(roster: Roster, paper: Paper, teachers: { uid: string; name: string }[]) {
    const el = ensureRoot();
    clearListeners();
    el.innerHTML = shell(paper.title, `Class ${esc(paper.className)}–${esc(paper.section)} · ${esc(paper.subject)} · ${declaredTotal(paper) || '—'} marks`, `<div class="osm-center"><div class="osm-spin"></div></div>`, 'Back to papers');
    wireClose(el, () => openOsmHome(roster));
    const me = B.teacher()!;
    let docs = new Map<string, StuDoc>();
    let meta: Meta = {}; let readFailed = false;
    async function reload() {
        readFailed = false;
        const [mSnap, ...sSnaps] = await Promise.all([
            metaRef(paper).get(),
            ...roster.students.map((s: any) => stuRef(paper, s.uid).get().catch(() => { readFailed = true; return null; })),
        ]);
        meta = mSnap.exists ? mSnap.data() : {};
        docs = new Map();
        roster.students.forEach((s: any, i: number) => { const sn: any = sSnaps[i]; if (sn?.exists) docs.set(s.uid, sn.data()); });
    }
    async function render() {
        const body = el.querySelector('.osm-body') as HTMLElement;
        const rows = roster.students.map((s: any) => {
            const d = docs.get(s.uid);
            const st = studentState(paper, d, meta, teachers);
            const sc = scoreFor(paper, d?.marks);
            return { s, d, st, sc };
        });
        const withSheets = rows.filter(r => r.d?.pages?.length);
        const readyN = rows.filter(r => r.st.ready).length;
        const allReady = withSheets.length > 0 && readyN === withSheets.length;
        const myAssign = meta.assign?.[me.uid] || [];
        body.innerHTML = `
          <div class="osm-toolbar">
            <div class="osm-kpis">
              <div class="osm-kpi"><b>${withSheets.length}</b><span>sheets uploaded</span></div>
              <div class="osm-kpi"><b>${readyN}</b><span>ready for analysis</span></div>
              <div class="osm-kpi"><b>${roster.students.length}</b><span>on roster</span></div>
            </div>
            <div class="osm-toolbar-btns">
              <button class="osm-btn" id="osm-assign">My questions${myAssign.length ? ` (${myAssign.length})` : ''}</button>
              <label class="osm-btn" for="osm-bulk">Bulk upload sheets</label><input id="osm-bulk" type="file" multiple accept="image/*,.pdf" hidden>
              <button class="osm-btn" id="osm-refresh">↻ Refresh</button>
            </div>
          </div>
          ${allReady ? `<div class="osm-banner ok">✔ All ${withSheets.length} uploaded papers are marked by every teacher — <b>ready for analysis</b>.</div>` : ''}
          <p class="osm-sub">Bulk upload: name each file with the roll number first, e.g. <code>9A01.pdf</code> or <code>9A01_page2.jpg</code>.</p>
          <div class="osm-table-wrap"><table class="osm-table"><thead><tr><th>Roll</th><th>Student</th><th>Sheet</th><th>Marks</th><th>Teachers done</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.map(({ s, d, st, sc }) => `<tr>
            <td>${esc(s.rollNumber || '')}</td><td>${esc(s.name)}</td>
            <td>${d?.pages?.length ? `${d.pages.length} page${d.pages.length > 1 ? 's' : ''}` : `<span class="osm-muted">—</span>`}
                <label class="osm-link" for="up-${esc(s.uid)}">${d?.pages?.length ? 'add' : 'upload'}</label><input id="up-${esc(s.uid)}" class="osm-up" data-uid="${esc(s.uid)}" type="file" multiple accept="image/*,.pdf" hidden></td>
            <td>${d?.pages?.length ? `${fmt1(sc.total)} / ${declaredTotal(paper) || '—'}` : '—'}</td>
            <td>${teachers.map(t => `<span class="osm-chip ${st.doneBy.includes(t.uid) ? 'on' : ''}" title="${esc(t.name)}">${esc(shortName(t.name, teachers))}${st.doneBy.includes(t.uid) ? ' ✓' : ''}</span>`).join('')}</td>
            <td><span class="osm-badge ${st.code}">${esc(st.label)}</span></td>
            <td>${d?.pages?.length ? `<button class="osm-btn small primary osm-open" data-uid="${esc(s.uid)}">Mark</button>` : ''}</td>
          </tr>`).join('')}
          </tbody></table></div>`;
        body.querySelector('#osm-refresh')!.addEventListener('click', async () => { B.loading(true, 'Refreshing…'); try { await reload(); await render(); } finally { B.loading(false); } });
        body.querySelector('#osm-assign')!.addEventListener('click', () => openAssignModal(paper, meta, me.uid, async (list) => {
            await metaRef(paper).set({ assign: { [me.uid]: list } }, { merge: true });
            await reload(); await render();
        }));
        body.querySelectorAll<HTMLButtonElement>('.osm-open').forEach(b => b.addEventListener('click', () => openDesk(roster, paper, teachers, b.dataset.uid!, rows.filter(r => r.d?.pages?.length).map(r => r.s.uid))));
        body.querySelectorAll<HTMLInputElement>('.osm-up').forEach(inp => inp.addEventListener('change', async () => {
            const files = Array.from(inp.files || []); if (!files.length) return;
            await uploadSheets(paper, inp.dataset.uid!, roster.students.find((x: any) => x.uid === inp.dataset.uid), files);
            await reload(); await render();
        }));
        (body.querySelector('#osm-bulk') as HTMLInputElement).addEventListener('change', async (ev) => {
            const files = Array.from((ev.target as HTMLInputElement).files || []);
            const groups = new Map<string, File[]>(); const unmatched: string[] = [];
            files.forEach(f => {
                const base = f.name.replace(/\.[^.]+$/, '').toLowerCase();
                const stu = roster.students.find((x: any) => { const rn = String(x.rollNumber || '').toLowerCase(); return rn && (base === rn || base.startsWith(rn + '_') || base.startsWith(rn + '-') || base.startsWith(rn + ' ')); });
                if (!stu) { unmatched.push(f.name); return; }
                if (!groups.has(stu.uid)) groups.set(stu.uid, []); groups.get(stu.uid)!.push(f);
            });
            if (unmatched.length) B.toast(`${unmatched.length} file(s) did not match a roll number and were skipped: ${unmatched.slice(0, 3).join(', ')}${unmatched.length > 3 ? '…' : ''}`, 'info');
            let i = 0;
            for (const [uid, fs] of groups) {
                i++; B.loading(true, `Uploading ${i}/${groups.size}…`);
                await uploadSheets(paper, uid, roster.students.find((x: any) => x.uid === uid), fs, true);
            }
            B.loading(false);
            await reload(); await render();
        });
        // keep the explicit readiness flag in sync (idempotent) so analysis can find ready papers fast
        if (readFailed) B.toast('Some students could not be loaded — press Refresh before relying on the status.', 'error');
        if (!readFailed && allReady !== !!meta.readyForAnalysis) {
            metaRef(paper).set({ readyForAnalysis: allReady, readyCount: readyN, sheetCount: withSheets.length, readyAt: allReady ? Date.now() : null }, { merge: true }).catch(() => { /* non-fatal */ });
        }
    }
    try { await reload(); await render(); }
    catch (e: any) { (el.querySelector('.osm-body') as HTMLElement).innerHTML = `<div class="osm-empty"><p>Could not load this paper.</p><p class="osm-sub">${esc(e?.message)}</p></div>`; }
}

async function uploadSheets(paper: Paper, studentUid: string, stu: any, files: File[], quiet = false) {
    const me = B.teacher()!;
    if (!quiet) B.loading(true, 'Uploading sheet…');
    try {
        files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        const pages: { url: string; path: string }[] = [];
        for (const f of files) {
            const imgs = f.type === 'application/pdf' ? await B.pdfToImages(f) : [f];
            for (const img of imgs) {
                let up = img; try { up = await B.processImage(img); } catch { /* use raw */ }
                const path = `gradedReports/${me.uid}/${paper.id}/${studentUid}/osm_${Date.now()}_${pages.length}_${img.name.replace(/[^\w.\-]/g, '_')}`;
                await B.storage.ref(path).put(up);
                pages.push({ path, url: await B.storage.ref(path).getDownloadURL() });
            }
        }
        // arrayUnion: two teachers adding pages to the same student at once can never drop each other's pages
        await stuRef(paper, studentUid).set({ studentUid, studentName: stu?.name || '', rollNumber: stu?.rollNumber || '', pages: B.FieldValue.arrayUnion(...pages), uploadedBy: me.uid, updatedAt: Date.now() }, { merge: true });
        if (!quiet) B.toast(`Uploaded ${pages.length} page(s) for ${stu?.name || 'student'}.`, 'success');
    } catch (e: any) { console.error('[osm] upload failed', e); B.toast('Upload failed: ' + e.message, 'error'); }
    finally { if (!quiet) B.loading(false); }
}

function openAssignModal(paper: Paper, meta: Meta, uid: string, onSave: (list: number[]) => Promise<void>) {
    const cur = new Set(meta.assign?.[uid] || []);
    const m = document.createElement('div'); m.className = 'osm-modal';
    m.innerHTML = `<div class="osm-modal-card">
      <h3>Which questions are yours?</h3>
      <p class="osm-sub">Co-teachers mark different questions. You can still see everyone's marks. Leave all unticked if you will mark the whole paper.</p>
      <div class="osm-range"><label>From <select id="osm-from">${paper.questions.map((q, i) => `<option value="${i}">${esc(q.questionNumber || i + 1)}</option>`).join('')}</select></label>
      <label>to <select id="osm-to">${paper.questions.map((q, i) => `<option value="${i}" ${i === paper.questions.length - 1 ? 'selected' : ''}>${esc(q.questionNumber || i + 1)}</option>`).join('')}</select></label>
      <button class="osm-btn small" id="osm-rng">Select range</button> <button class="osm-btn small" id="osm-none">Clear</button></div>
      <div class="osm-checks">${paper.questions.map((q, i) => `<label class="osm-check"><input type="checkbox" data-i="${i}" ${cur.has(i) ? 'checked' : ''}> ${esc(q.questionNumber || i + 1)}<small>${fmt1(qMax(q))}</small></label>`).join('')}</div>
      <div class="osm-actions"><button class="osm-btn" id="osm-m-cancel">Cancel</button><button class="osm-btn primary" id="osm-m-save">Save</button></div></div>`;
    document.body.appendChild(m);
    const boxes = () => Array.from(m.querySelectorAll<HTMLInputElement>('.osm-check input'));
    m.querySelector('#osm-rng')!.addEventListener('click', () => {
        let a = Number((m.querySelector('#osm-from') as HTMLSelectElement).value), b = Number((m.querySelector('#osm-to') as HTMLSelectElement).value);
        if (a > b) [a, b] = [b, a]; boxes().forEach(c => { const i = Number(c.dataset.i); if (i >= a && i <= b) c.checked = true; });
    });
    m.querySelector('#osm-none')!.addEventListener('click', () => boxes().forEach(c => c.checked = false));
    m.querySelector('#osm-m-cancel')!.addEventListener('click', () => m.remove());
    m.querySelector('#osm-m-save')!.addEventListener('click', async () => {
        const list = boxes().filter(c => c.checked).map(c => Number(c.dataset.i));
        try { await onSave(list); m.remove(); B.toast('Saved.', 'success'); } catch (e: any) { B.toast('Could not save: ' + e.message, 'error'); }
    });
}

// ───────────────────────── SCREEN C: marking desk ─────────────────────────
type InkStroke = { c: string; w: number; d: string };
async function openDesk(roster: Roster, paper: Paper, teachers: { uid: string; name: string }[], studentUid: string, order: string[]) {
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

    const myIdx = new Set<number>(meta.assign?.[me.uid] || []);
    const hasAssign = myIdx.size > 0;
    let unlockAll = !hasAssign;
    const pos = order.indexOf(studentUid);
    const inks: Record<string, Record<string, InkStroke[]>> = {};   // teacherUid -> page -> strokes
    const nameOf = (u: string) => teachers.find(t => t.uid === u)?.name || 'Teacher';
    let zoom = Number((() => { try { return localStorage.getItem('osm-zoom'); } catch { return null; } })()) || 100;
    let tool: 'none' | 'pen' | 'erase' = 'none'; let penColor = '#d93025'; let penW = 3;
    const theme = (() => { try { return localStorage.getItem('osm-theme') || 'light'; } catch { return 'light'; } })();

    el.innerHTML = `
      <div class="osm-desk ${theme === 'dark' ? 'dark' : ''}" id="osm-desk">
        <div class="osm-desk-top">
          <button class="osm-btn ghost" id="osm-close">← Papers</button>
          <div class="osm-titlebox"><div class="osm-title">${esc(doc.studentName || stu?.name || '')} <span class="osm-sub">Roll ${esc(doc.rollNumber || stu?.rollNumber || '')}</span></div><div class="osm-sub">${esc(paper.title)}</div></div>
          <div class="osm-tools">
            <div class="osm-seg"><button id="t-view" class="on" title="Scroll / look">☝ View</button><button id="t-pen" title="Pen">✏ Pen</button><button id="t-erase" title="Erase your strokes">⌫ Erase</button></div>
            <input type="color" id="t-color" value="${penColor}" title="Pen colour"><select id="t-w" title="Pen width"><option value="2">Thin</option><option value="3" selected>Medium</option><option value="6">Thick</option></select>
            <button class="osm-btn small" id="t-undo" title="Undo last stroke on the page you drew on">↶ Undo</button>
            <div class="osm-seg zoom"><button id="z-out">−</button><span id="z-val">${zoom}%</span><button id="z-in">+</button></div>
            <button class="osm-btn small" id="t-theme" title="Dark / light panel">${theme === 'dark' ? '☀' : '☾'}</button>
          </div>
        </div>
        <div class="osm-desk-main">
          <div class="osm-pages" id="osm-pages"></div>
          <aside class="osm-side" id="osm-side"></aside>
        </div>
      </div>`;
    const desk = el.querySelector('#osm-desk') as HTMLElement;
    const pagesEl = el.querySelector('#osm-pages') as HTMLElement;
    const sideEl = el.querySelector('#osm-side') as HTMLElement;
    el.querySelector('#osm-close')!.addEventListener('click', () => openPaperRoster(roster, paper, teachers));

    // ---- pages + ink -------------------------------------------------------
    const pageWrap: HTMLElement[] = []; const pageDims: { w: number; h: number }[] = [];
    (doc.pages || []).forEach((p, i) => {
        const w = document.createElement('div'); w.className = 'osm-page'; w.dataset.i = String(i);
        w.innerHTML = `<div class="osm-pg-label">Page ${i + 1} of ${doc.pages!.length}</div><div class="osm-pg-inner"><img alt="Page ${i + 1}" draggable="false"><svg class="osm-ink" xmlns="http://www.w3.org/2000/svg"></svg></div>`;
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
    function renderInk(i: number) {
        const svg = pageWrap[i].querySelector('svg') as SVGSVGElement; if (!svg) return;
        svg.innerHTML = Object.entries(inks).map(([tu, pg]) => (pg[String(i)] || []).map((s, si) =>
             `<path d="${esc(s.d)}" stroke="${esc(s.c)}" stroke-width="${Number(s.w) || 3}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${tu === me.uid ? 1 : 0.55}" data-t="${esc(tu)}" data-s="${si}"/>`).join('')).join('');
        svg.style.pointerEvents = tool === 'none' ? 'none' : 'auto';
        svg.style.cursor = tool === 'pen' ? 'crosshair' : tool === 'erase' ? 'cell' : 'default';
    }
    let inkTimer: any = null; let lastInkPage = -1;
    let inkDirty = false;
    function flushInk() {
        clearTimeout(inkTimer); if (!inkDirty) return; inkDirty = false;
        const mine = inks[me.uid] || {};
        inkRef(paper, studentUid, me.uid).set({ teacherUid: me.uid, teacherName: me.name, pages: mine, updatedAt: Date.now() }).catch(e => B.toast('Could not save pen marks: ' + e.message, 'error'));
    }
    function saveInk() { inkDirty = true; clearTimeout(inkTimer); inkTimer = setTimeout(flushInk, 700); }
    window.addEventListener('pagehide', flushInk);
    // drawing
    pagesEl.addEventListener('pointerdown', (ev: PointerEvent) => {
        if (tool === 'none') return;
        const svg = (ev.target as Element).closest('svg.osm-ink') as SVGSVGElement | null; if (!svg) return;
        const wrap = svg.closest('.osm-page') as HTMLElement; const i = Number(wrap.dataset.i);
        const vb = svg.viewBox.baseVal; const rect = svg.getBoundingClientRect();
        const pt = (e: PointerEvent) => ({ x: ((e.clientX - rect.left) / rect.width) * vb.width, y: ((e.clientY - rect.top) / rect.height) * vb.height });
        if (tool === 'erase') {
            const hit = (ev.target as Element).closest('path[data-t]') as SVGPathElement | null;
            if (hit && hit.dataset.t === me.uid) { const arr = inks[me.uid]?.[String(i)]; if (arr) { arr.splice(Number(hit.dataset.s), 1); renderInk(i); saveInk(); } }
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
            if (d.includes('L')) { (inks[me.uid] ||= {}); (inks[me.uid][String(i)] ||= []).push({ c: penColor, w: penW, d }); lastInkPage = i; saveInk(); }
            renderInk(i);
        };
        svg.addEventListener('pointermove', mv); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
    });
    // load existing ink (all teachers); live-updates
    (async () => {
        try {
            const snap = await paperRef(paper.owner, paper.id).collection('submissions').doc(studentUid).collection('detail').get();
            snap.docs.forEach((d: any) => { if (d.id.startsWith('osmInk_')) { const tu = d.id.slice(7); if (tu === me.uid && inks[me.uid]) { Object.entries(d.data().pages || {}).forEach(([pg, arr]: any) => { const cur = (inks[me.uid][pg] ||= []); if (!cur.length) inks[me.uid][pg] = arr; else inks[me.uid][pg] = [...arr, ...cur.filter((c: any) => !arr.some((a: any) => a.d === c.d))]; }); } else inks[tu] = d.data().pages || {}; } });
            pageWrap.forEach((_, i) => renderInk(i));
        } catch (e) { console.warn('[osm] ink load', e); }
    })();

    // ---- tool buttons ------------------------------------------------------
    const setTool = (t: typeof tool) => {
        tool = t; (['view', 'pen', 'erase'] as const).forEach(k => el.querySelector('#t-' + k)!.classList.toggle('on', (k === 'view' ? 'none' : k) === t));
        pageWrap.forEach((_, i) => renderInk(i));
    };
    el.querySelector('#t-view')!.addEventListener('click', () => setTool('none'));
    el.querySelector('#t-pen')!.addEventListener('click', () => setTool('pen'));
    el.querySelector('#t-erase')!.addEventListener('click', () => setTool('erase'));
    (el.querySelector('#t-color') as HTMLInputElement).addEventListener('input', e => { penColor = (e.target as HTMLInputElement).value; });
    (el.querySelector('#t-w') as HTMLSelectElement).addEventListener('change', e => { penW = Number((e.target as HTMLSelectElement).value); });
    el.querySelector('#t-undo')!.addEventListener('click', () => { if (lastInkPage < 0) return; const arr = inks[me.uid]?.[String(lastInkPage)]; if (arr?.length) { arr.pop(); renderInk(lastInkPage); saveInk(); } });
    const setZoom = (z: number) => { zoom = Math.max(50, Math.min(250, z)); (el.querySelector('#z-val') as HTMLElement).textContent = zoom + '%'; try { localStorage.setItem('osm-zoom', String(zoom)); } catch { /* */ } pageWrap.forEach((_, i) => sizePage(i)); };
    el.querySelector('#z-in')!.addEventListener('click', () => setZoom(zoom + 10));
    el.querySelector('#z-out')!.addEventListener('click', () => setZoom(zoom - 10));
    el.querySelector('#t-theme')!.addEventListener('click', () => { const dk = desk.classList.toggle('dark'); try { localStorage.setItem('osm-theme', dk ? 'dark' : 'light'); } catch { /* */ } (el.querySelector('#t-theme') as HTMLElement).textContent = dk ? '☀' : '☾'; });

    // ---- marks panel -------------------------------------------------------
    const saveTimers: Record<number, any> = {}; const pendingRun: Record<number, () => void> = {};
    function flushMarks() { Object.keys(pendingRun).forEach(k => { const i = Number(k); clearTimeout(saveTimers[i]); const f = pendingRun[i]; delete pendingRun[i]; f(); }); }
    let savingCount = 0; let statusEl: HTMLElement | null = null;
    const setStatus = (t: string, cls = '') => { if (statusEl) { statusEl.textContent = t; statusEl.className = 'osm-save ' + cls; } };
    function editable(i: number) { return unlockAll || myIdx.has(i); }
    function renderSide() {
        const prevScroll = (sideEl.querySelector('#osm-qs') as HTMLElement | null)?.scrollTop ?? 0;
        const openDet = new Set(Array.from(sideEl.querySelectorAll<HTMLDetailsElement>('.osm-q')).filter(r => (r.querySelector('details') as HTMLDetailsElement | null)?.open).map(r => r.dataset.i));
        renderSideInner();
        const qs = sideEl.querySelector('#osm-qs') as HTMLElement | null; if (qs) qs.scrollTop = prevScroll;
        openDet.forEach(i => { const d = sideEl.querySelector(`.osm-q[data-i="${i}"] details`) as HTMLDetailsElement | null; if (d) d.open = true; });
    }
    function renderSideInner() {
        const sc = scoreFor(paper, doc.marks);
        const st = studentState(paper, doc, meta, teachers);
        const iAmDone = !!doc.done?.[me.uid];
        const dt = declaredTotal(paper);
        sideEl.innerHTML = `
          <div class="osm-score"><div class="osm-score-num">${fmt1(sc.total)}<small> / ${dt || '—'}</small></div>
            <div class="osm-bar"><i style="width:${dt ? Math.min(100, sc.total / dt * 100) : 0}%"></i></div>
            <div class="osm-sub"><span id="osm-marked">${sc.marked}/${sc.count}</span> questions marked · <span id="osm-save" class="osm-save"></span></div></div>
          ${hasAssign ? `<label class="osm-unlock"><input type="checkbox" id="osm-unlock" ${unlockAll ? 'checked' : ''}> Also let me edit other teachers' questions</label>` : `<div class="osm-sub osm-pad">You're marking the whole paper. Use “My questions” on the previous screen if co-teachers split the paper.</div>`}
          <div class="osm-qs" id="osm-qs">
          ${paper.questions.map((q, i) => {
              const m = doc.marks?.[qk(i)]; const mine = editable(i); const loser = sc.losers.has(q.questionNumber || String(i + 1));
              const max = qMax(q);
              return `<div class="osm-q ${mine ? '' : 'other'} ${m ? 'has' : ''} ${loser ? 'loser' : ''}" data-i="${i}">
                <div class="osm-q-head"><span class="osm-qn">Q${esc(q.questionNumber || i + 1)}</span>${/alternative question \(or\)/i.test(q.checkingInstructions || '') ? '<span class="osm-tag">OR</span>' : ''}${hasAssign && myIdx.has(i) ? '<span class="osm-tag mine">yours</span>' : ''}
                  <span class="osm-max">out of ${fmt1(max)}</span></div>
                <div class="osm-q-row">
                  <button class="osm-mini" data-act="zero" ${mine ? '' : 'disabled'} title="Give 0">0</button>
                  <input class="osm-in" type="text" inputmode="decimal" autocomplete="off" value="${m ? m.v : ''}" placeholder="–" ${mine ? '' : 'disabled'} data-i="${i}">
                  <button class="osm-mini" data-act="full" ${mine ? '' : 'disabled'} title="Give full marks">Full</button>
                </div>
                ${m && m.by !== me.uid ? `<div class="osm-by">marked by ${esc(m.n || nameOf(m.by))}</div>` : ''}
                ${loser ? '<div class="osm-by">alternative not counted (other option scored higher)</div>' : ''}
                <details class="osm-det"><summary>Question &amp; model answer</summary><div class="osm-qtext">${B.fmtMath(esc(q.text || ''))}</div>${q.answer ? `<div class="osm-ans"><b>Answer:</b> ${B.fmtMath(esc(q.answer))}</div>` : ''}${q.checkingInstructions ? `<div class="osm-ci">${esc(q.checkingInstructions)}</div>` : ''}</details>
              </div>`;
          }).join('')}
          </div>
          <div class="osm-foot">
            <div class="osm-doneline">${paper.questions.length ? teachers.map(t => `<span class="osm-chip ${doc.done?.[t.uid] ? 'on' : ''}">${esc(shortName(t.name, teachers))}${doc.done?.[t.uid] ? ' ✓' : ''}</span>`).join('') : ''}</div>
            ${st.ready ? '<div class="osm-banner ok small">✔ Ready for analysis</div>' : ''}
            <button class="osm-btn ${iAmDone ? '' : 'primary'} wide" id="osm-given">${iAmDone ? '✓ Marks given — click to reopen' : 'Marks Given'}</button>
            <div class="osm-nav"><button class="osm-btn small" id="osm-prev" ${pos > 0 ? '' : 'disabled'}>← Previous student</button><button class="osm-btn small" id="osm-next" ${pos >= 0 && pos < order.length - 1 ? '' : 'disabled'}>Next student →</button></div>
          </div>`;
        statusEl = sideEl.querySelector('#osm-save');
        B.typeset(sideEl);
        wireSide();
    }
    function wireSide() {
        sideEl.querySelector('#osm-unlock')?.addEventListener('change', e => { unlockAll = (e.target as HTMLInputElement).checked; renderSide(); });
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
            const row = b.closest('.osm-q') as HTMLElement; const i = Number(row.dataset.i); const inp = row.querySelector('.osm-in') as HTMLInputElement;
            inp.value = b.dataset.act === 'full' ? String(qMax(paper.questions[i])) : '0'; queueSave(i, inp.value, inp, true);
        }));
        sideEl.querySelector('#osm-given')!.addEventListener('click', toggleDone);
        sideEl.querySelector('#osm-prev')?.addEventListener('click', () => pos > 0 && openDesk(roster, paper, teachers, order[pos - 1], order));
        sideEl.querySelector('#osm-next')?.addEventListener('click', () => pos < order.length - 1 && openDesk(roster, paper, teachers, order[pos + 1], order));
    }
    function queueSave(i: number, raw: string, inp: HTMLInputElement, immediate = false) {
        clearTimeout(saveTimers[i]);
        const run = async () => {
            const max = qMax(paper.questions[i]);
            if (raw.trim() === '') return;   // clearing a box does not delete a saved mark by accident
            if (/[.,]$/.test(raw.trim())) return;   // still typing "1." — wait for the next digit
            let v = Math.round(parseFloat(raw.replace(',', '.')) * 2) / 2;   // marks are in half-mark steps
            if (isNaN(v) || v < 0) v = 0; if (max > 0 && v > max) { v = max; B.toast(`Q${paper.questions[i].questionNumber || i + 1} is out of ${fmt1(max)} — set to ${fmt1(max)}.`, 'info'); }
            if (document.activeElement !== inp) inp.value = String(v);
            const entry = { v, by: me.uid, n: me.name, t: Date.now() };
            (doc.marks ||= {})[qk(i)] = entry;
            // a changed mark reopens the teacher's own "Marks Given" so it is never stale
            savingCount++; setStatus('Saving…');
            try {
                const patch: any = { studentUid, studentName: doc.studentName || stu?.name || '', rollNumber: doc.rollNumber || stu?.rollNumber || '', marks: { [qk(i)]: entry }, updatedAt: Date.now() };
                // Editing a mark after "Marks Given" reopens this teacher's own done flag, so it can never be stale.
                const reopened = !!doc.done?.[me.uid];
                if (reopened) patch.done = { [me.uid]: B.FieldValue.delete() };
                await stuRef(paper, studentUid).set(patch, { merge: true });
                if (reopened) { delete doc.done![me.uid]; renderSideKeepFocus(); }
                savingCount--; if (!savingCount) setStatus('Saved ✓', 'ok');
                refreshScoreOnly();
            } catch (e: any) { savingCount--; setStatus('Not saved — check connection', 'bad'); B.toast('Could not save mark: ' + e.message, 'error'); }
        };
        pendingRun[i] = run;
        const go = () => { delete pendingRun[i]; run(); };
        if (immediate) { clearTimeout(saveTimers[i]); go(); } else saveTimers[i] = setTimeout(go, 600);
    }
    function renderSideKeepFocus() {
        const a = document.activeElement as HTMLInputElement | null; const i = a?.classList.contains('osm-in') ? a.dataset.i : null; const v = a?.value;
        renderSide();
        if (i != null) { const n = sideEl.querySelector(`.osm-in[data-i="${i}"]`) as HTMLInputElement | null; if (n) { n.value = v ?? n.value; n.focus(); } }
        B.toast('You changed a mark, so “Marks Given” was reopened — click it again when finished.', 'info');
    }
    function refreshScoreOnly() {
        const sc = scoreFor(paper, doc.marks); const dt = declaredTotal(paper);
        const n = sideEl.querySelector('.osm-score-num'); if (n) n.innerHTML = `${fmt1(sc.total)}<small> / ${dt || '—'}</small>`;
        const mk = sideEl.querySelector('#osm-marked'); if (mk) mk.textContent = `${sc.marked}/${sc.count}`;
        const bar = sideEl.querySelector('.osm-bar i') as HTMLElement | null; if (bar) bar.style.width = (dt ? Math.min(100, sc.total / dt * 100) : 0) + '%';
        sideEl.querySelectorAll<HTMLElement>('.osm-q').forEach(r => { const i = Number(r.dataset.i); const q = paper.questions[i]; r.classList.toggle('has', doc.marks?.[qk(i)] !== undefined); r.classList.toggle('loser', sc.losers.has(q.questionNumber || String(i + 1))); });
    }
    async function toggleDone() {
        const iAmDone = !!doc.done?.[me.uid];
        if (!iAmDone) {
            const mine = paper.questions.map((_, i) => i).filter(i => hasAssign ? myIdx.has(i) : true);
            // An unattempted alternative (OR) question needs no mark when its partner has one: it is saved as 0 for you.
            const partnerOf = (i: number) => { const ci = String(paper.questions[i].checkingInstructions || ''); if (!/alternative question \(or\)/i.test(ci)) return -1; const m = ci.match(/with\s+question\s+([\w.\-\s()]+?)(?:\.\s|\.$|,|;|$)/i); if (!m) return -1; const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, ''); return paper.questions.findIndex(q => n(q.questionNumber || '') === n(m[1])); };
            const autoZero = mine.filter(i => doc.marks?.[qk(i)] === undefined && partnerOf(i) >= 0 && doc.marks?.[qk(partnerOf(i))] !== undefined);
            for (const i of autoZero) { const e = { v: 0, by: me.uid, n: me.name, t: Date.now() }; (doc.marks ||= {})[qk(i)] = e; await stuRef(paper, studentUid).set({ marks: { [qk(i)]: e }, updatedAt: Date.now() }, { merge: true }); }
            if (autoZero.length) renderSide();
            const missing = mine.filter(i => doc.marks?.[qk(i)] === undefined);
            if (missing.length) {
                const first = missing[0];
                B.toast(`${missing.length} question(s) still have no mark (first: Q${paper.questions[first].questionNumber || first + 1}). Enter 0 if the student scored nothing.`, 'error');
                const row = sideEl.querySelector(`.osm-q[data-i="${first}"]`) as HTMLElement | null; row?.scrollIntoView({ block: 'center', behavior: 'smooth' }); row?.classList.add('flash'); setTimeout(() => row?.classList.remove('flash'), 1500);
                return;
            }
        }
        try {
            const ref = stuRef(paper, studentUid);
            if (iAmDone) { await ref.update({ ['done.' + me.uid]: B.FieldValue.delete() }); delete doc.done![me.uid]; }
            else { await ref.set({ done: { [me.uid]: { n: me.name, t: Date.now() } } }, { merge: true }); (doc.done ||= {})[me.uid] = { n: me.name, t: Date.now() }; }
            renderSide();
            B.toast(iAmDone ? 'Reopened for editing.' : 'Marks given ✓', 'success');
        } catch (e: any) { B.toast('Could not update: ' + e.message, 'error'); }
    }
    renderSide();

    // live updates from co-teachers (does not disturb a box you are typing in)
    const unsub = stuRef(paper, studentUid).onSnapshot((snap: any) => {
        if (!snap.exists || snap.metadata.hasPendingWrites) return;
        const d = snap.data(); const active = document.activeElement as HTMLInputElement | null;
        let changed = false;
        Object.entries(d.marks || {}).forEach(([k, v]: any) => { const cur = doc.marks?.[k]; if (!cur || cur.t < v.t) { if (!(active?.classList.contains('osm-in') && qk(Number(active.dataset.i)) === k)) { (doc.marks ||= {})[k] = v; changed = true; } } });
        const nd = JSON.stringify(Object.keys(d.done || {}).sort()); if (nd !== JSON.stringify(Object.keys(doc.done || {}).sort())) { doc.done = d.done || {}; changed = true; }
        if (!changed) return;
        if (!active?.classList.contains('osm-in')) renderSide();
        else {   // you are typing: update every OTHER box in place, never the one you are in
            sideEl.querySelectorAll<HTMLInputElement>('.osm-in').forEach(inp => { if (inp !== active) { const m = doc.marks?.[qk(Number(inp.dataset.i))]; if (m) inp.value = String(m.v); } });
            refreshScoreOnly();
        }
    }, (e: any) => console.warn('[osm] live listener', e));
    stopListeners.push(unsub);
    stopListeners.push(() => { flushInk(); window.removeEventListener('pagehide', flushInk); Object.keys(saveTimers).forEach(k => { /* pending mark saves are flushed below */ }); flushMarks(); });
}

// ───────────────────────── styles ─────────────────────────
function injectStyle() {
    if (document.getElementById('osm-style')) return;
    const s = document.createElement('style'); s.id = 'osm-style';
    s.textContent = `
#osm-root{position:fixed;inset:0;z-index:9000;background:var(--osm-bg);color:var(--osm-fg);display:none;overflow:auto;font-family:'Inter','Segoe UI',system-ui,sans-serif;
 --osm-bg:#f6f5f1;--osm-card:#ffffff;--osm-fg:#23262b;--osm-muted:#6b7280;--osm-line:#e4e2db;--osm-accent:#2f6f5e;--osm-accent-fg:#fff;--osm-warn:#b45309;--osm-bad:#b42318;--osm-ok:#1f7a4d;--osm-soft:#eef3f0}
body.osm-active{overflow:hidden}
#osm-root *{box-sizing:border-box}
.osm-top,.osm-desk-top{display:flex;align-items:center;gap:16px;padding:12px 20px;background:var(--osm-card);border-bottom:1px solid var(--osm-line);position:sticky;top:0;z-index:5}
.osm-titlebox{flex:1;min-width:0}.osm-title{font-size:1.15rem;font-weight:650}.osm-sub{font-size:.85rem;color:var(--osm-muted)}
.osm-body{max-width:1180px;margin:0 auto;padding:22px 20px 60px}
.osm-btn{border:1px solid var(--osm-line);background:var(--osm-card);color:var(--osm-fg);border-radius:10px;padding:9px 15px;font-size:.92rem;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px}
.osm-btn:hover{background:var(--osm-soft)}.osm-btn.primary{background:var(--osm-accent);color:var(--osm-accent-fg);border-color:var(--osm-accent)}.osm-btn.primary:hover{filter:brightness(1.08)}
.osm-btn.ghost{border-color:transparent;background:transparent}.osm-btn.small{padding:6px 11px;font-size:.84rem}.osm-btn.wide{width:100%;justify-content:center;padding:13px;font-size:1rem}.osm-btn:disabled{opacity:.45;cursor:not-allowed}
.osm-toolbar{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px}.osm-toolbar h2{margin:0;font-size:1.1rem}.osm-toolbar-btns{display:flex;gap:8px;flex-wrap:wrap}
.osm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.osm-card{text-align:left;background:var(--osm-card);border:1px solid var(--osm-line);border-radius:14px;padding:18px;cursor:pointer;font-family:inherit;color:inherit}.osm-card:hover{border-color:var(--osm-accent);box-shadow:0 2px 10px rgba(0,0,0,.06)}
.osm-card-title{font-weight:650;font-size:1.02rem;margin-bottom:6px}
.osm-empty{text-align:center;padding:60px 20px;color:var(--osm-muted)}.osm-center{display:flex;justify-content:center;padding:80px}
.osm-spin{width:34px;height:34px;border-radius:50%;border:3px solid var(--osm-line);border-top-color:var(--osm-accent);animation:osmspin .8s linear infinite}@keyframes osmspin{to{transform:rotate(360deg)}}
.osm-form{max-width:760px;background:var(--osm-card);border:1px solid var(--osm-line);border-radius:14px;padding:22px;display:flex;flex-direction:column;gap:14px}
.osm-form label{display:flex;flex-direction:column;gap:6px;font-weight:600;font-size:.9rem}.osm-form input{padding:10px 12px;border:1px solid var(--osm-line);border-radius:9px;font-size:.95rem;font-family:inherit;background:var(--osm-bg);color:var(--osm-fg)}
.osm-note{background:var(--osm-soft);border-radius:10px;padding:10px 14px;font-size:.88rem}.osm-actions{display:flex;gap:10px;justify-content:flex-end}
.osm-qtable{max-height:340px;overflow:auto;border:1px solid var(--osm-line);border-radius:10px;margin-top:8px}.osm-qtable table,.osm-table{width:100%;border-collapse:collapse;font-size:.88rem}
.osm-qtable th,.osm-qtable td,.osm-table th,.osm-table td{padding:8px 12px;border-bottom:1px solid var(--osm-line);text-align:left;vertical-align:middle}.osm-table th,.osm-qtable th{background:var(--osm-soft);position:sticky;top:0;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--osm-muted)}
.osm-table-wrap{background:var(--osm-card);border:1px solid var(--osm-line);border-radius:14px;overflow:auto}
.osm-kpis{display:flex;gap:12px}.osm-kpi{background:var(--osm-card);border:1px solid var(--osm-line);border-radius:12px;padding:10px 18px;display:flex;flex-direction:column}.osm-kpi b{font-size:1.4rem}.osm-kpi span{font-size:.78rem;color:var(--osm-muted)}
.osm-badge{padding:3px 10px;border-radius:99px;font-size:.78rem;font-weight:600;background:#eceae4;color:#555;white-space:nowrap}.osm-badge.ready{background:#d7efe3;color:var(--osm-ok)}.osm-badge.prog{background:#fdf0d5;color:var(--osm-warn)}.osm-badge.nosheet{background:#f0efea;color:#999}
.osm-chip{display:inline-block;padding:2px 9px;border-radius:99px;font-size:.76rem;border:1px solid var(--osm-line);color:var(--osm-muted);margin-right:4px}.osm-chip.on{background:#d7efe3;color:var(--osm-ok);border-color:#b8e0cb}
.osm-link{color:var(--osm-accent);cursor:pointer;font-size:.84rem;margin-left:6px;text-decoration:underline}.osm-muted{color:var(--osm-muted)}
.osm-banner{padding:12px 16px;border-radius:10px;margin:12px 0}.osm-banner.ok{background:#d7efe3;color:var(--osm-ok)}.osm-banner.small{padding:8px 12px;font-size:.88rem;margin:8px 0}
.osm-teachers{margin-top:20px}
.osm-modal{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9500;display:flex;align-items:center;justify-content:center;padding:20px}.osm-modal-card{background:var(--osm-card,#fff);color:#23262b;border-radius:16px;padding:22px;max-width:680px;width:100%;max-height:88vh;overflow:auto}
.osm-range{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}.osm-checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:6px;margin:10px 0}.osm-check{border:1px solid #e4e2db;border-radius:8px;padding:6px 8px;font-size:.88rem;display:flex;gap:6px;align-items:center;cursor:pointer}.osm-check small{color:#888;margin-left:auto}
/* desk */
.osm-desk{--osm-bg:#f6f5f1;position:fixed;inset:0;display:flex;flex-direction:column;background:#3a3f47}
.osm-desk.dark{--osm-bg:#1d2025;--osm-card:#262a31;--osm-fg:#e6e8eb;--osm-muted:#9aa1ab;--osm-line:#363b44;--osm-soft:#2e333b;--osm-accent:#5fb89c;--osm-accent-fg:#0d1f19}
.osm-desk-top{flex-wrap:wrap;background:var(--osm-card);color:var(--osm-fg)}
.osm-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.osm-seg{display:inline-flex;border:1px solid var(--osm-line);border-radius:10px;overflow:hidden}.osm-seg button{border:0;background:var(--osm-card);color:var(--osm-fg);padding:7px 12px;cursor:pointer;font-size:.86rem;font-family:inherit}.osm-seg button.on{background:var(--osm-accent);color:var(--osm-accent-fg)}.osm-seg.zoom span{padding:7px 8px;min-width:52px;text-align:center;font-size:.84rem;background:var(--osm-card);color:var(--osm-fg)}
.osm-tools input[type=color]{width:34px;height:32px;border:1px solid var(--osm-line);border-radius:8px;padding:2px;background:var(--osm-card)}.osm-tools select{padding:6px;border-radius:8px;border:1px solid var(--osm-line);background:var(--osm-card);color:var(--osm-fg)}
.osm-desk-main{flex:1;display:flex;min-height:0}
.osm-pages{flex:1;overflow:auto;padding:18px 24px 80px;background:#3a3f47;display:flex;flex-direction:column;align-items:center;gap:18px}
.osm-page{width:100%;display:flex;flex-direction:column;align-items:center}.osm-pg-label{color:#aeb4bd;font-size:.78rem;margin-bottom:6px;align-self:flex-start;max-width:100%}
.osm-pg-inner{position:relative;max-width:none;background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.35)}.osm-pg-inner img{width:100%;display:block;user-select:none}.osm-ink{position:absolute;inset:0;width:100%;height:100%;touch-action:none}
.osm-side{width:370px;max-width:42vw;background:var(--osm-card);color:var(--osm-fg);border-left:1px solid var(--osm-line);display:flex;flex-direction:column;min-height:0}
.osm-score{padding:14px 18px 10px;border-bottom:1px solid var(--osm-line)}.osm-score-num{font-size:2rem;font-weight:700;line-height:1.1}.osm-score-num small{font-size:1rem;font-weight:500;color:var(--osm-muted)}
.osm-bar{height:6px;background:var(--osm-line);border-radius:6px;margin:8px 0;overflow:hidden}.osm-bar i{display:block;height:100%;background:var(--osm-accent);transition:width .25s}
.osm-save{font-size:.8rem}.osm-save.ok{color:var(--osm-ok)}.osm-save.bad{color:var(--osm-bad)}
.osm-unlock{padding:8px 18px;font-size:.82rem;color:var(--osm-muted);display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--osm-line)}.osm-pad{padding:8px 18px}
.osm-qs{flex:1;overflow:auto;padding:8px 12px}
.osm-q{border:1px solid var(--osm-line);border-radius:12px;padding:10px 12px;margin:8px 0;background:var(--osm-card)}.osm-q.has{border-left:4px solid var(--osm-accent)}.osm-q.other{opacity:.65}.osm-q.loser{opacity:.55;text-decoration:none}.osm-q.flash{box-shadow:0 0 0 3px var(--osm-warn)}
.osm-q-head{display:flex;align-items:center;gap:8px}.osm-qn{font-weight:700;font-size:1rem}.osm-max{margin-left:auto;font-size:.82rem;color:var(--osm-muted)}
.osm-tag{font-size:.68rem;padding:1px 7px;border-radius:99px;background:#ece6f7;color:#5b3fa0}.osm-tag.mine{background:#d7efe3;color:var(--osm-ok)}
.osm-q-row{display:flex;gap:8px;margin-top:8px;align-items:center}
.osm-in{flex:1;min-width:0;font-size:1.35rem;font-weight:650;text-align:center;padding:8px;border:2px solid var(--osm-line);border-radius:10px;background:var(--osm-bg);color:var(--osm-fg);font-family:inherit}.osm-in:focus{outline:none;border-color:var(--osm-accent)}.osm-in:disabled{background:transparent;border-style:dashed}
.osm-mini{padding:9px 12px;border:1px solid var(--osm-line);background:var(--osm-card);color:var(--osm-fg);border-radius:9px;cursor:pointer;font-size:.88rem;font-family:inherit}.osm-mini:hover:not(:disabled){background:var(--osm-soft)}.osm-mini:disabled{opacity:.35}
.osm-by{font-size:.76rem;color:var(--osm-muted);margin-top:6px}
.osm-det{margin-top:8px;font-size:.84rem}.osm-det summary{cursor:pointer;color:var(--osm-muted)}.osm-qtext,.osm-ans,.osm-ci{margin-top:6px;line-height:1.5;white-space:pre-wrap}.osm-ci{color:var(--osm-muted);font-size:.8rem}
.osm-foot{border-top:1px solid var(--osm-line);padding:12px 14px;display:flex;flex-direction:column;gap:8px}.osm-doneline{display:flex;flex-wrap:wrap;gap:4px}.osm-nav{display:flex;justify-content:space-between;gap:8px}
@media (max-width:900px){.osm-side{width:320px}.osm-kpis{display:none}}
`;
    document.head.appendChild(s);
}
