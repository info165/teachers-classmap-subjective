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
export function initOsm(bridge: OsmBridge) { B = bridge; injectStyle(); }

// ───────────────────────── types ─────────────────────────
interface Paper {
    owner: string; id: string; title: string; className: string; section: string; subject: string; stream: string;
    totalMarks: number; questions: any[]; created: string; schoolName: string;
}
interface Roster { id: string; className: string; section: string; subject: string; stream?: string; schoolName: string; students: any[]; board?: string; teacherUid: string }
interface StuDoc { pagesVersion?: number; studentUid: string; studentName: string; rollNumber: string; pages?: { url: string; path: string }[]; marks?: Record<string, { v: number; by: string; n: string; t: number }>; done?: Record<string, { n: string; t: number }>; }
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
        <button class="osm-btn ghost" id="osm-close">← ${esc(backLabel)}</button>
        <div class="osm-titlebox"><div class="osm-title">${esc(title)}</div><div class="osm-sub">${sub}</div></div>
        <div class="osm-top-right"></div></div>
      <div class="osm-body">${bodyHtml}</div>`;
}
function wireClose(el: HTMLElement, fn?: () => void) {
    el.querySelector('#osm-close')?.addEventListener('click', fn || (() => { closeOsm(); B.backToClass(); }));
}

// ───────────────────────── SCREEN B: paper screen (upload + mark, one view) ─────────────────────────
async function openPaper(roster: Roster, paper: Paper, teachers: { uid: string; name: string }[]) {
    const el = ensureRoot();
    clearListeners();
    el.innerHTML = shell(paper.title, `Class ${esc(paper.className)}–${esc(paper.section)} · ${esc(paper.subject)} · ${declaredTotal(paper) || '—'} marks · ${paper.questions.length} questions`, `<div class="osm-center"><div class="osm-spin"></div></div>`, 'Back to class');
    wireClose(el);
    const me = B.teacher()!;
    let docs = new Map<string, StuDoc>();
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
    }
    async function render() {
        const body = el.querySelector('.osm-body') as HTMLElement | null; if (!body) return;
        const scroll = (el as HTMLElement).scrollTop;
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
              <div class="osm-kpi"><b>${withSheets.length}<small>/${roster.students.length}</small></b><span>sheets uploaded</span></div>
              <div class="osm-kpi"><b>${readyN}</b><span>ready for analysis</span></div>
            </div>
            <div class="osm-toolbar-btns">
              <button class="osm-btn" id="osm-assign" title="Pick which questions you will mark, if co-teachers split the paper">My questions${myAssign.length ? ` (${myAssign.length})` : ''}</button>
            </div>
          </div>
          ${allReady ? `<div class="osm-banner ok">✔ All ${withSheets.length} uploaded papers are marked by every teacher — <b>ready for analysis</b>.</div>` : ''}
          <div class="osm-table-wrap"><table class="osm-table"><thead><tr><th>Roll</th><th>Student</th><th>Answer sheet</th><th>Marks</th><th>Teachers done</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.map(({ s, d, st, sc }) => `<tr>
            <td>${esc(s.rollNumber || '')}</td><td class="osm-nm">${esc(s.name)}</td>
            <td>${d?.pages?.length ? `<span class="osm-pgs">${d.pages.length} page${d.pages.length > 1 ? 's' : ''}</span> <button class="osm-link osm-up" data-uid="${esc(s.uid)}">Add / replace</button>` : `<button class="osm-btn small osm-up" data-uid="${esc(s.uid)}">⬆ Upload sheet</button>`}</td>
            <td>${d?.pages?.length ? `<b>${fmt1(sc.total)}</b> / ${declaredTotal(paper) || '—'}` : '—'}</td>
            <td>${teachers.map(t => `<span class="osm-chip ${st.doneBy.includes(t.uid) ? 'on' : ''}" title="${esc(t.name)}">${esc(shortName(t.name, teachers))}${st.doneBy.includes(t.uid) ? ' ✓' : ''}</span>`).join('')}</td>
            <td><span class="osm-badge ${st.code}">${esc(st.label)}</span></td>
            <td>${d?.pages?.length ? `<button class="osm-btn small primary osm-open" data-uid="${esc(s.uid)}">Mark</button>` : ''}</td>
          </tr>`).join('')}
          </tbody></table></div>`;
        (el as HTMLElement).scrollTop = scroll;
        body.querySelector('#osm-assign')!.addEventListener('click', () => openAssignModal(paper, meta, me.uid, async (list) => {
            await metaRef(paper).set({ assign: { [me.uid]: list } }, { merge: true });
            await reload(); await render();
        }));
        const order = rows.filter(r => r.d?.pages?.length).map(r => r.s.uid);
        body.querySelectorAll<HTMLButtonElement>('.osm-open').forEach(b => b.addEventListener('click', () => openDesk(roster, paper, teachers, b.dataset.uid!, order)));
        body.querySelectorAll<HTMLButtonElement>('.osm-up').forEach(b => b.addEventListener('click', () => {
            const stu = roster.students.find((x: any) => x.uid === b.dataset.uid);
            openUploadModal(paper, stu, docs.get(b.dataset.uid!)?.pages?.length || 0, async () => { busyFlag = true; try { await reload(); await render(); } finally { busyFlag = false; } });
        }));
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
function openUploadModal(paper: Paper, stu: any, existing: number, onDone: () => Promise<void>) {
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
        await saveSheets(paper, stu, files, mode);
        await onDone();
    });
}

// Same storage location + PDF→image handling as the Exams answer-sheet upload:
//   gradedReports/{teacherUid}/{paperId}/{studentUid}/{time}_{filename}   (PDF pages are already enhanced, photos are processed)
async function saveSheets(paper: Paper, stu: any, files: File[], mode: 'add' | 'replace') {
    const me = B.teacher()!; const studentUid = stu?.uid;
    busy(true, 'Preparing pages…');
    try {
        const expanded: File[] = [];
        for (const f of files) { if (f.type === 'application/pdf') expanded.push(...await B.pdfToImages(f)); else expanded.push(f); }
        let n = 0;
        const pages = await Promise.all(expanded.map(async (img, idx) => {
            const up = img.name.includes('_page_') ? img : await B.processImage(img).catch(() => img);
            const path = `gradedReports/${me.uid}/${paper.id}/${studentUid}/${img.lastModified || Date.now()}_${Date.now().toString(36)}${idx}_${img.name.replace(/[^\w.\-]/g, '_')}`;
            await B.storage.ref(path).put(up);
            const url = await B.storage.ref(path).getDownloadURL();
            busy(true, `Uploading page ${++n} of ${expanded.length}…`);
            return { path, url };
        }));
        const base = { studentUid, studentName: stu?.name || '', rollNumber: stu?.rollNumber || '', uploadedBy: me.uid, updatedAt: Date.now() };
        if (mode === 'replace') {
            // pen strokes were drawn on the old pages — remove them first so they cannot land on the new pages.
            // pagesVersion also makes any ink saved later from an already-open desk (old pages) be ignored on load.
            let inkNote = '';
            try {
                const det = await paperRef(paper.owner, paper.id).collection('submissions').doc(studentUid).collection('detail').get();
                await Promise.all(det.docs.filter((d: any) => d.id.startsWith('osmInk_')).map((d: any) => d.ref.delete()));
            } catch (e: any) { inkNote = ' Old pen marks could not be deleted, but they will be ignored.'; console.warn('[osm] ink cleanup', e); }
            await stuRef(paper, studentUid).set({ ...base, pages, pagesVersion: Date.now() }, { merge: true });
            if (inkNote) toast(inkNote.trim(), 'info');
        } else {
            // arrayUnion: two teachers adding pages to the same student at once can never drop each other's pages
            await stuRef(paper, studentUid).set({ ...base, pages: B.FieldValue.arrayUnion(...pages) }, { merge: true });
        }
        toast(mode === 'replace' ? `Sheet replaced (${pages.length} page${pages.length > 1 ? 's' : ''}).` : `Added ${pages.length} page${pages.length > 1 ? 's' : ''} for ${stu?.name || 'student'}.`, 'success');
    } catch (e: any) { console.error('[osm] upload failed', e); toast('Upload failed: ' + e.message, 'error'); }
    finally { busy(false); }
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
        try { await onSave(list); m.remove(); toast('Saved.', 'success'); } catch (e: any) { toast('Could not save: ' + e.message, 'error'); }
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
            <span class="osm-inkstat" id="osm-ink-status" title="Your pen marks are saved to your own layer on this sheet. Co-teachers see them in lighter ink; you can only erase your own."></span>
            <button class="osm-btn small" id="t-theme" title="Dark / light panel">${theme === 'dark' ? '☀' : '☾'}</button>
          </div>
        </div>
        <div class="osm-desk-main">
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
    function renderInk(i: number) {
        const svg = pageWrap[i].querySelector('svg') as SVGSVGElement; if (!svg) return;
        svg.innerHTML = Object.entries(inks).map(([tu, pg]) => (pg[String(i)] || []).map((s, si) =>
             `<path d="${esc(s.d)}" stroke="${esc(s.c)}" stroke-width="${Number(s.w) || 3}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${tu === me.uid ? 1 : 0.55}" data-t="${esc(tu)}" data-s="${si}"/>`).join('')).join('');
        const mineN = (inks[me.uid]?.[String(i)] || []).length; const theirN = Object.entries(inks).reduce((a, [tu, pg]) => a + (tu === me.uid ? 0 : (pg[String(i)] || []).length), 0);
        const lab = pageWrap[i].querySelector('.osm-pg-n') as HTMLElement | null; if (lab) lab.textContent = (mineN || theirN) ? `· ${mineN} pen mark${mineN === 1 ? '' : 's'} by you${theirN ? `, ${theirN} by co-teachers` : ''}` : '';
        svg.style.pointerEvents = tool === 'none' ? 'none' : 'auto';
        svg.style.cursor = tool === 'pen' ? 'crosshair' : tool === 'erase' ? 'cell' : 'default';
    }
    let inkTimer: any = null; let lastInkPage = -1;
    let inkDirty = false; let inkSaving = 0; let alive = true; let inkLoaded = false; let inkFails = 0;
    const myStrokeCount = () => Object.values(inks[me.uid] || {}).reduce((a, arr: any) => a + arr.length, 0);
    function setInkStatus(kind: 'idle' | 'dirty' | 'saving' | 'saved' | 'error') {
        if (!alive) return;
        const e = desk.querySelector('#osm-ink-status') as HTMLElement | null; if (!e) return;
        const n = myStrokeCount();
        e.className = 'osm-inkstat ' + kind;
        e.textContent = kind === 'saving' ? '⏳ Saving pen marks…' : kind === 'dirty' ? '● Pen marks not saved yet' : kind === 'error' ? '⚠ Pen marks NOT saved — retrying' : kind === 'saved' ? `✓ Pen marks saved (${n})` : (n ? `✓ ${n} pen mark${n > 1 ? 's' : ''} saved` : 'Pen: nothing drawn yet');
    }
    function flushInk() {
        clearTimeout(inkTimer); if (!inkDirty) return;
        // never write before your saved strokes have loaded (the write replaces your whole ink doc)
        if (!inkLoaded) { inkTimer = setTimeout(flushInk, 500); return; }
        inkDirty = false;
        const mine = inks[me.uid] || {};
        inkSaving++; setInkStatus('saving');
        inkRef(paper, studentUid, me.uid).set({ teacherUid: me.uid, teacherName: me.name, pages: mine, pv: doc.pagesVersion ?? null, updatedAt: Date.now() })
            .then(() => { inkSaving--; inkFails = 0; if (!inkSaving && !inkDirty) setInkStatus('saved'); })
            .catch(e => {
                inkSaving--; inkDirty = true; inkFails++; setInkStatus('error');
                if (inkFails <= 5 && alive) { toast('Could not save pen marks: ' + e.message + ' — retrying', 'error'); clearTimeout(inkTimer); inkTimer = setTimeout(flushInk, 4000); }
                else if (alive) toast('Pen marks still not saved. Please check your connection before leaving this sheet.', 'error');
            });
    }
    function saveInk() { inkDirty = true; setInkStatus('dirty'); clearTimeout(inkTimer); inkTimer = setTimeout(flushInk, 700); }
    const warnUnload = (e: BeforeUnloadEvent) => { if (alive && (inkDirty || inkSaving)) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warnUnload);
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
            snap.docs.forEach((d: any) => { if (d.id.startsWith('osmInk_')) { if ((d.data().pv ?? null) !== (doc.pagesVersion ?? null)) return; const tu = d.id.slice(7); if (tu === me.uid && inks[me.uid]) { Object.entries(d.data().pages || {}).forEach(([pg, arr]: any) => { const cur = (inks[me.uid][pg] ||= []); if (!cur.length) inks[me.uid][pg] = arr; else inks[me.uid][pg] = [...arr, ...cur.filter((c: any) => !arr.some((a: any) => a.d === c.d))]; }); } else inks[tu] = d.data().pages || {}; } });
            pageWrap.forEach((_, i) => renderInk(i)); inkLoaded = true; setInkStatus('idle');
        } catch (e) { console.warn('[osm] ink load', e); inkLoaded = true; toast('Could not load existing pen marks — new marks will still be saved.', 'info'); }
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
    el.querySelector('#t-theme')!.addEventListener('click', () => { const dk = desk.classList.toggle('dark'); try { localStorage.setItem('osm-theme', dk ? 'dark' : 'light'); } catch { /* */ } (el.querySelector('#t-theme') as HTMLElement).textContent = dk ? '☀' : '☾'; });

    // ---- marks panel -------------------------------------------------------
    const saveTimers: Record<number, any> = {}; const pendingRun: Record<number, () => void> = {};
    function flushMarks() { return Promise.all(Object.keys(pendingRun).map(k => { const i = Number(k); clearTimeout(saveTimers[i]); const f = pendingRun[i]; delete pendingRun[i]; return f(); })); }
    let savingCount = 0; let statusEl: HTMLElement | null = null;
    const setStatus = (t: string, cls = '') => { if (statusEl) { statusEl.textContent = t; statusEl.className = 'osm-save ' + cls; } };
    function chipValues(max: number): number[] {
        if (!(max > 0)) return [];
        const step = max <= 10 ? 0.5 : 1; const out: number[] = [];
        for (let v = 0; v <= max + 1e-9; v += step) out.push(Math.round(v * 2) / 2);
        return out.length <= 41 ? out : [];
    }
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
                  <button class="osm-mini step" data-act="dec" ${mine ? '' : 'disabled'} title="− 0.5">−</button>
                  <input class="osm-in" type="text" inputmode="decimal" autocomplete="off" value="${m ? esc(Number(m.v)) : ''}" placeholder="–" ${mine ? '' : 'disabled'} data-i="${i}">
                  <button class="osm-mini step" data-act="inc" ${mine ? '' : 'disabled'} title="+ 0.5">+</button>
                  <button class="osm-mini full" data-act="full" ${mine ? '' : 'disabled'} title="Give full marks">Full</button>
                </div>
                ${chipValues(max).length ? `<div class="osm-chips">${chipValues(max).map(v => `<button class="osm-cv ${m && m.v === v ? 'sel' : ''}" data-v="${v}" ${mine ? '' : 'disabled'}>${fmt1(v)}</button>`).join('')}</div>` : ''}
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
            const row = b.closest('.osm-q') as HTMLElement; const i = Number(row.dataset.i); const inp = row.querySelector('.osm-in') as HTMLInputElement; const max = qMax(paper.questions[i]);
            const cur = doc.marks?.[qk(i)]?.v; let v: number;
            if (b.dataset.act === 'full') v = max;
            else if (b.dataset.act === 'inc') v = Math.min(max || Infinity, (cur ?? 0) + 0.5);
            else v = Math.max(0, (cur ?? 0) - 0.5);
            inp.value = String(v); queueSave(i, inp.value, inp, true);
        }));
        sideEl.querySelectorAll<HTMLButtonElement>('.osm-cv').forEach(b => b.addEventListener('click', () => {
            const row = b.closest('.osm-q') as HTMLElement; const i = Number(row.dataset.i); const inp = row.querySelector('.osm-in') as HTMLInputElement;
            inp.value = b.dataset.v!; queueSave(i, inp.value, inp, true);
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
            if (isNaN(v) || v < 0) v = 0; if (max > 0 && v > max) { v = max; toast(`Q${paper.questions[i].questionNumber || i + 1} is out of ${fmt1(max)} — set to ${fmt1(max)}.`, 'info'); }
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
            } catch (e: any) { savingCount--; setStatus('Not saved — check connection', 'bad'); toast('Could not save mark: ' + e.message, 'error'); }
        };
        pendingRun[i] = run;
        const go = () => { delete pendingRun[i]; run(); };
        if (immediate) { clearTimeout(saveTimers[i]); go(); } else saveTimers[i] = setTimeout(go, 600);
    }
    function renderSideKeepFocus() {
        const a = document.activeElement as HTMLInputElement | null; const i = a?.classList.contains('osm-in') ? a.dataset.i : null; const v = a?.value;
        renderSide();
        if (i != null) { const n = sideEl.querySelector(`.osm-in[data-i="${i}"]`) as HTMLInputElement | null; if (n) { n.value = v ?? n.value; n.focus(); } }
        toast('You changed a mark, so “Marks Given” was reopened — click it again when finished.', 'info');
    }
    function refreshScoreOnly() {
        const sc = scoreFor(paper, doc.marks); const dt = declaredTotal(paper);
        const n = sideEl.querySelector('.osm-score-num'); if (n) n.innerHTML = `${fmt1(sc.total)}<small> / ${dt || '—'}</small>`;
        const mk = sideEl.querySelector('#osm-marked'); if (mk) mk.textContent = `${sc.marked}/${sc.count}`;
        const bar = sideEl.querySelector('.osm-bar i') as HTMLElement | null; if (bar) bar.style.width = (dt ? Math.min(100, sc.total / dt * 100) : 0) + '%';
        sideEl.querySelectorAll<HTMLElement>('.osm-q').forEach(r => { const i = Number(r.dataset.i); const q = paper.questions[i]; r.classList.toggle('has', doc.marks?.[qk(i)] !== undefined); { const cur = doc.marks?.[qk(i)]?.v; r.querySelectorAll<HTMLElement>('.osm-cv').forEach(c => c.classList.toggle('sel', cur !== undefined && Number(c.dataset.v) === cur)); } r.classList.toggle('loser', sc.losers.has(q.questionNumber || String(i + 1))); });
    }
    async function toggleDone() {
        await flushMarks();   // a mark typed a moment ago must count
        const iAmDone = !!doc.done?.[me.uid];
        if (!iAmDone) {
            const mine = paper.questions.map((_, i) => i).filter(i => hasAssign ? myIdx.has(i) : true);
            // An unattempted alternative (OR) question needs no mark when its partner has one: it is saved as 0 for you.
            const partnerOf = (i: number) => { const ci = String(paper.questions[i].checkingInstructions || ''); if (!/alternative question \(or\)/i.test(ci)) return -1; const m = ci.match(/with\s+question\s+([\w.\-\s()]+?)(?:\.\s|\.$|,|;|$)/i); if (!m) return -1; const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, ''); return paper.questions.findIndex(q => n(q.questionNumber || '') === n(m[1])); };
            const autoZero = mine.filter(i => doc.marks?.[qk(i)] === undefined && partnerOf(i) >= 0 && doc.marks?.[qk(partnerOf(i))] !== undefined);
            try { for (const i of autoZero) { const e = { v: 0, by: me.uid, n: me.name, t: Date.now() }; (doc.marks ||= {})[qk(i)] = e; await stuRef(paper, studentUid).set({ marks: { [qk(i)]: e }, updatedAt: Date.now() }, { merge: true }); } }
            catch (e: any) { toast('Could not save: ' + e.message, 'error'); return; }
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
            renderSide();
            toast(iAmDone ? 'Reopened for editing.' : 'Marks given ✓', 'success');
        } catch (e: any) { toast('Could not update: ' + e.message, 'error'); }
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
    stopListeners.push(() => { flushInk(); alive = false; window.removeEventListener('beforeunload', warnUnload); window.removeEventListener('pagehide', flushInk); Object.keys(saveTimers).forEach(k => { /* pending mark saves are flushed below */ }); flushMarks(); });
}

// ───────────────────────── styles (ClassMap look: Poppins, blue→purple gradient, soft rounded cards) ─────────────────────────
function injectStyle() {
    if (document.getElementById('osm-style')) return;
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
.osm-pages-wrap{flex:1;position:relative;min-width:0;display:flex}
.osm-pages{flex:1;overflow:auto;padding:18px 24px 90px;background:#2b3040;display:flex;flex-direction:column;align-items:center;gap:18px}
.osm-zoombar{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:4px;background:rgba(30,34,50,.92);color:#fff;border-radius:99px;padding:5px 8px;box-shadow:0 6px 24px rgba(0,0,0,.4);backdrop-filter:blur(6px);font-size:.84rem;z-index:3}
.osm-zoombar button{border:0;background:transparent;color:#fff;font-size:1.1rem;min-width:34px;height:34px;border-radius:99px;cursor:pointer;font-family:inherit}.osm-zoombar button:hover{background:rgba(255,255,255,.18)}.osm-zoombar span{min-width:48px;text-align:center}.osm-zoombar #z-page{min-width:90px;color:#b9c2da}.osm-zoombar i{width:1px;height:20px;background:rgba(255,255,255,.25);margin:0 4px}
.osm-page{width:100%;display:flex;flex-direction:column;align-items:center}.osm-pg-label{color:#aab3c9;font-size:.76rem;margin-bottom:6px;align-self:flex-start;max-width:100%}.osm-pg-n{color:#8fb4ff}
.osm-pg-inner{position:relative;max-width:none;background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.4);border-radius:3px}.osm-pg-inner img{width:100%;display:block;user-select:none}.osm-ink{position:absolute;inset:0;width:100%;height:100%;touch-action:none}
.osm-side{width:410px;max-width:44vw;background:var(--osm-card);color:var(--osm-fg);border-left:1px solid var(--osm-line);display:flex;flex-direction:column;min-height:0}
.osm-score{padding:12px 18px 10px;border-bottom:1px solid var(--osm-line)}.osm-score-num{font-size:2.1rem;font-weight:700;line-height:1.1;background:var(--osm-grad);-webkit-background-clip:text;background-clip:text;color:transparent}.osm-score-num small{font-size:1rem;font-weight:500;color:var(--osm-muted);-webkit-text-fill-color:var(--osm-muted)}
.osm-bar{height:7px;background:var(--osm-line);border-radius:7px;margin:8px 0;overflow:hidden}.osm-bar i{display:block;height:100%;background:var(--osm-grad);transition:width .25s}
.osm-save{font-size:.78rem}.osm-save.ok{color:var(--osm-ok)}.osm-save.bad{color:var(--osm-bad)}
.osm-unlock{padding:8px 18px;font-size:.8rem;color:var(--osm-muted);display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--osm-line)}.osm-pad{padding:8px 18px}
.osm-qs{flex:1;overflow:auto;padding:8px 12px}
.osm-q{border:1px solid var(--osm-line);border-radius:16px;padding:10px 12px;margin:8px 0;background:var(--osm-card)}.osm-q.has{border-left:4px solid var(--osm-accent)}.osm-q.other{opacity:.65}.osm-q.loser{opacity:.55}.osm-q.flash{box-shadow:0 0 0 3px #f5a623}
.osm-q-head{display:flex;align-items:center;gap:8px}.osm-qn{font-weight:700;font-size:1.02rem}.osm-max{margin-left:auto;font-size:.8rem;color:var(--osm-muted)}
.osm-tag{font-size:.66rem;padding:1px 8px;border-radius:99px;background:#ece6f7;color:#5b3fa0}.osm-tag.mine{background:#d9f3e6;color:var(--osm-ok)}
.osm-q-row{display:flex;gap:6px;margin-top:8px;align-items:stretch}
.osm-in{flex:1;min-width:0;font-size:1.4rem;font-weight:700;text-align:center;padding:6px;border:2px solid var(--osm-line);border-radius:12px;background:var(--osm-bg);color:var(--osm-fg);font-family:inherit}.osm-in:focus{outline:none;border-color:var(--osm-accent)}.osm-in:disabled{background:transparent;border-style:dashed}
.osm-mini{padding:0 12px;min-width:44px;border:1px solid var(--osm-line);background:var(--osm-card);color:var(--osm-fg);border-radius:12px;cursor:pointer;font-size:.9rem;font-family:inherit;font-weight:600}.osm-mini.step{font-size:1.4rem;line-height:1;min-width:48px}.osm-mini.full{background:var(--osm-soft);color:var(--osm-accent)}.osm-mini:hover:not(:disabled){background:var(--osm-soft);border-color:var(--osm-accent)}.osm-mini:disabled{opacity:.35}
.osm-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.osm-cv{min-width:42px;height:38px;padding:0 6px;border:1.5px solid var(--osm-line);background:var(--osm-card);color:var(--osm-fg);border-radius:10px;cursor:pointer;font-size:.9rem;font-weight:600;font-family:inherit}.osm-cv:hover:not(:disabled){border-color:var(--osm-accent);background:var(--osm-soft)}.osm-cv.sel{background:var(--osm-grad);color:#fff;border-color:transparent;box-shadow:0 2px 8px rgba(37,117,252,.35)}.osm-cv:disabled{opacity:.35}
.osm-by{font-size:.74rem;color:var(--osm-muted);margin-top:6px}
.osm-det{margin-top:8px;font-size:.84rem}.osm-det summary{cursor:pointer;color:var(--osm-muted)}.osm-qtext,.osm-ans,.osm-ci{margin-top:6px;line-height:1.5;white-space:pre-wrap}.osm-ci{color:var(--osm-muted);font-size:.8rem}
.osm-foot{border-top:1px solid var(--osm-line);padding:10px 12px;display:flex;flex-direction:column;gap:7px}.osm-doneline{display:flex;flex-wrap:wrap;gap:3px}.osm-doneline .osm-chip{font-size:.7rem;padding:1px 7px;margin-right:0}.osm-nav{display:flex;justify-content:space-between;gap:8px}
#osm-toasts{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9950;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;font-family:'Poppins',system-ui,sans-serif}
.osm-toast{background:#2b3040;color:#fff;padding:11px 18px;border-radius:14px;font-size:.88rem;box-shadow:0 8px 30px rgba(0,0,0,.35);max-width:min(560px,92vw)}.osm-toast.error{background:#c0392b}.osm-toast.success{background:#1e9e5a}
#osm-busy{position:fixed;inset:0;z-index:9900;background:rgba(245,247,250,.82);display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:center;font-family:'Poppins',system-ui,sans-serif;color:#34495e;font-weight:500}
@media (max-width:900px){.osm-side{width:340px}.osm-kpis{display:none}}
`;
    document.head.appendChild(s);
}
