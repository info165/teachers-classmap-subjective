// ============================================================================
// COST ANALYTICS DASHBOARD — pages / papers / re-scans (replacement block)
//
// HOW TO APPLY (Super Admin app, index.tsx):
//   1. Find the line   `async function navigateToCostAnalytics() {`
//      and the line     `// --- DATA EXPLORER (generic Firestore browser / editor) ---`
//      DELETE everything between them (that removes the old navigateToCostAnalytics,
//      PagesRow/pagesRows, updateDashboard, renderKpiCards, renderCharts,
//      renderAllTables, the 4 table renderers and renderLogTable).
//   2. Paste this ENTIRE file in their place. Nothing else in index.tsx changes —
//      every function name the rest of the app calls (navigateToCostAnalytics,
//      updateDashboard, renderAllTables, renderLogTable, renderKpiCards,
//      renderCharts) still exists below.
//   3. Keep PRICING / formatCurrency / recalculateGrossCost / getSkuCategory
//      (they sit ABOVE navigateToCostAnalytics and are untouched).
//
// DATA SOURCE: the `gradingEvents` collection (one tiny document per grading
// attempt — see vertex-ai-backend/gradingStats.js). Reading it never touches the
// 36 KB report documents, and the date filter is a plain server-side range query
// (no composite index needed). The School filter is applied in the browser.
// ============================================================================

// ==CM-CORE-START== (pure logic — no DOM, no Firebase; unit-tested in Node)

interface CmEvent {
    id: string;
    kind: 'graded' | 'failed';
    ts: number;                 // epoch ms
    teacherUid: string;
    teacherName: string;
    schoolId: string;
    schoolName: string;
    assessmentId: string;
    studentUid: string;
    pages: number;
    isRegrade: boolean | null;  // null = unknown (backfilled history)
    backfilled: boolean;
}

interface CmRow {
    key: string;
    name: string;
    sub: string;                // secondary label (school for a teacher row)
    pagesScanned: number;       // every attempt: graded + re-graded + failed
    pagesGraded: number;        // unique papers, counted once
    papers: number;             // unique papers
    gradings: number;           // grading runs that completed (includes re-gradings)
    regradings: number;         // runs that re-graded an already-graded paper
    failed: number;             // failed attempts
    failedPages: number;        // pages inside those failed attempts
    rescanPages: number;        // pagesScanned - pagesGraded
    teachers: number;
    students: number;
    last: number;               // last activity (epoch ms)
}

function cmNormalizeEvent(id: string, d: any): CmEvent | null {
    if (!d) return null;
    const t = d.timestamp;
    const ts = t && typeof t.toMillis === 'function' ? t.toMillis()
        : (t && typeof t.seconds === 'number' ? t.seconds * 1000 : (typeof t === 'number' ? t : 0));
    if (!ts) return null;
    return {
        id,
        kind: d.kind === 'failed' ? 'failed' : 'graded',
        ts,
        teacherUid: d.teacherUid || '',
        teacherName: d.teacherName || '',
        schoolId: d.schoolId || '',
        schoolName: d.schoolName || '',
        assessmentId: d.assessmentId || '',
        studentUid: d.studentUid || '',
        pages: Number(d.pages) || 0,
        isRegrade: d.isRegrade === true ? true : (d.isRegrade === false ? false : null),
        backfilled: !!d.backfilled,
    };
}

// Which school does an event belong to? schoolId when it is a known school;
// otherwise match the school NAME; otherwise bucket as "unattributed".
function cmSchoolOf(e: CmEvent, nameById: Map<string, string>, idByName: Map<string, string>): { id: string; name: string } {
    if (e.schoolId && nameById.has(e.schoolId)) return { id: e.schoolId, name: nameById.get(e.schoolId)! };
    const byName = e.schoolName ? idByName.get(e.schoolName.trim().toLowerCase()) : undefined;
    if (byName) return { id: byName, name: nameById.get(byName)! };
    if (e.schoolName) return { id: 'name:' + e.schoolName.trim().toLowerCase(), name: e.schoolName };
    return { id: 'unattributed', name: 'Unattributed (teacher has no school)' };
}

function cmMetrics(key: string, name: string, sub: string, list: CmEvent[]): CmRow {
    const graded = list.filter(e => e.kind === 'graded');
    const failed = list.filter(e => e.kind === 'failed');
    // A paper (assessment + student) graded several times counts once for "unique" pages.
    const latestByPaper = new Map<string, CmEvent>();
    graded.forEach(e => {
        const k = e.assessmentId + '|' + e.studentUid;
        const cur = latestByPaper.get(k);
        if (!cur || e.ts >= cur.ts) latestByPaper.set(k, e);
    });
    let pagesGraded = 0;
    latestByPaper.forEach(e => { pagesGraded += e.pages; });
    const pagesScanned = graded.reduce((s, e) => s + e.pages, 0) + failed.reduce((s, e) => s + e.pages, 0);
    return {
        key, name, sub,
        pagesScanned,
        pagesGraded,
        papers: latestByPaper.size,
        gradings: graded.length,
        regradings: graded.filter(e => e.isRegrade === true).length,
        failed: failed.length,
        failedPages: failed.reduce((s, e) => s + e.pages, 0),
        rescanPages: Math.max(0, pagesScanned - pagesGraded),
        teachers: new Set(list.map(e => e.teacherUid).filter(Boolean)).size,
        students: new Set(graded.map(e => e.studentUid).filter(Boolean)).size,
        last: list.reduce((m, e) => Math.max(m, e.ts), 0),
    };
}

function cmGroup(events: CmEvent[], keyFn: (e: CmEvent) => { key: string; name: string; sub?: string }): CmRow[] {
    const groups = new Map<string, { name: string; sub: string; list: CmEvent[] }>();
    events.forEach(e => {
        const g = keyFn(e);
        if (!groups.has(g.key)) groups.set(g.key, { name: g.name, sub: g.sub || '', list: [] });
        groups.get(g.key)!.list.push(e);
    });
    return Array.from(groups.entries()).map(([k, g]) => cmMetrics(k, g.name, g.sub, g.list));
}

function cmDayKey(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface CmResult {
    totals: CmRow;
    schoolsActive: number;
    bySchool: CmRow[];
    byTeacher: CmRow[];
    byDay: CmRow[];
    regradeTrackedSince: number | null;   // earliest event for which isRegrade is known
    eventCount: number;
}

function cmAggregate(events: CmEvent[], schoolFilter: string, nameById: Map<string, string>): CmResult {
    const idByName = new Map<string, string>();
    nameById.forEach((n, id) => idByName.set(n.trim().toLowerCase(), id));
    const filtered = (schoolFilter && schoolFilter !== 'all')
        ? events.filter(e => cmSchoolOf(e, nameById, idByName).id === schoolFilter)
        : events;
    const bySchool = cmGroup(filtered, e => { const s = cmSchoolOf(e, nameById, idByName); return { key: s.id, name: s.name }; });
    const byTeacher = cmGroup(filtered, e => ({
        key: e.teacherUid || 'unknown',
        name: e.teacherName || '(unknown teacher)',
        sub: cmSchoolOf(e, nameById, idByName).name,
    }));
    const byDay = cmGroup(filtered, e => ({ key: cmDayKey(e.ts), name: cmDayKey(e.ts) }));
    const totals = cmMetrics('all', 'All', '', filtered);
    const known = filtered.filter(e => e.kind === 'graded' && e.isRegrade !== null);
    return {
        totals,
        schoolsActive: bySchool.filter(r => r.key !== 'unattributed').length,
        bySchool, byTeacher, byDay,
        regradeTrackedSince: known.length ? known.reduce((m, e) => Math.min(m, e.ts), Infinity) : null,
        eventCount: filtered.length,
    };
}

// ==CM-CORE-END==

// ----------------------------------------------------------------------------
// UI + Firestore wiring
// ----------------------------------------------------------------------------

let cmEventsCache: { key: string; events: CmEvent[] } | null = null;
let cmLastResult: CmResult | null = null;
let cmSchoolList: { uid: string; schoolName: string }[] = [];
const cmSort: { [table: string]: { key: keyof CmRow; dir: 'asc' | 'desc' } } = {
    school: { key: 'pagesScanned', dir: 'desc' },
    teacher: { key: 'pagesScanned', dir: 'desc' },
    day: { key: 'name', dir: 'desc' },
};
const CM_PAGE_LIMIT = { teacher: 200 };

function cmEsc(s: any): string {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}
const cmNum = (n: number) => (n || 0).toLocaleString('en-IN');
const cmWhen = (ts: number) => ts ? new Date(ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

// Builds (once) the container this dashboard renders into, and hides the old
// token-based widgets that used to live in the Cost Analytics section.
function cmEnsureRoot(): HTMLElement {
    let root = document.getElementById('cm-analytics-root');
    if (root) return root;
    const section = costAnalyticsSectionEl;
    const filterCard = startDateFilterEl.closest('#cost-analytics-section > *') as HTMLElement | null;
    Array.from(section.children).forEach(ch => {
        const el = ch as HTMLElement;
        if (el === filterCard) return;
        if (/^(H[1-6]|P)$/.test(el.tagName)) return;      // page title + subtitle stay
        el.style.display = 'none';                        // old KPI cards / tables
    });
    // The "App Type" filter only made sense for token logs — hide it.
    const appWrap = appTypeFilterEl?.parentElement as HTMLElement | null;
    if (appWrap) appWrap.style.display = 'none';
    const style = document.createElement('style');
    style.textContent = `
      #cm-analytics-root .cm-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin:18px 0}
      #cm-analytics-root .cm-kpi{background:#fff;border-radius:12px;padding:16px 18px;box-shadow:0 2px 10px rgba(0,0,0,.06);border-top:4px solid var(--c,#6a11cb)}
      #cm-analytics-root .cm-kpi .l{font-size:.78rem;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}
      #cm-analytics-root .cm-kpi .v{font-size:1.9rem;font-weight:800;color:var(--c,#6a11cb);margin:4px 0 2px}
      #cm-analytics-root .cm-kpi .s{font-size:.76rem;color:#8a8f98;line-height:1.35}
      #cm-analytics-root .cm-card{background:#fff;border-radius:12px;padding:16px 18px;box-shadow:0 2px 10px rgba(0,0,0,.06);margin-bottom:18px}
      #cm-analytics-root .cm-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
      #cm-analytics-root .cm-head h3{margin:0;font-size:1.05rem;flex:1}
      #cm-analytics-root .cm-head input{padding:6px 10px;border:1px solid #d6dae0;border-radius:8px;font-size:.85rem}
      #cm-analytics-root th.cm-sort{cursor:pointer;white-space:nowrap}
      #cm-analytics-root th.cm-sort:hover{background:#eef1f6}
      #cm-analytics-root .cm-note{font-size:.8rem;color:#6b7280;background:#f6f8fb;border-radius:8px;padding:10px 12px;margin:8px 0;line-height:1.5}
      #cm-analytics-root .cm-warn{background:#fff8e1;color:#7a5b00;border:1px solid #ffe08a}
      #cm-analytics-root td.n{text-align:right;font-variant-numeric:tabular-nums}
      #cm-analytics-root td.warn{color:#c0392b;font-weight:600}`;
    document.head.appendChild(style);
    root = document.createElement('div');
    root.id = 'cm-analytics-root';
    section.appendChild(root);
    return root;
}

function cmParseDay(value: string, endOfDay: boolean): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!m) return null;
    const d = endOfDay
        ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999)
        : new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
    return d.getTime();
}

async function cmLoadSchoolList() {
    if (allSchools.length > 0) { cmSchoolList = allSchools.map((s: any) => ({ uid: s.uid, schoolName: s.schoolName })); return; }
    if (cmSchoolList.length > 0) return;
    const snap = await fbFirestore.collection('schools').get();
    cmSchoolList = snap.docs.map((d: any) => ({ uid: d.id, schoolName: (d.data() as any).schoolName || d.id }));
}

async function navigateToCostAnalytics() {
    updateUIVisibility('cost_analytics');
    cmEnsureRoot();
    try {
        await cmLoadSchoolList();
    } catch (e) { console.warn('[CostAnalytics] school list failed', e); }
    if (schoolFilterEl.options.length <= 1) {
        const sorted = [...cmSchoolList].sort((a, b) => a.schoolName.localeCompare(b.schoolName));
        schoolFilterEl.innerHTML = `<option value="all">All Schools</option>` +
            sorted.map(s => `<option value="${s.uid}">${cmEsc(s.schoolName)}</option>`).join('');
        const today = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        startDateFilterEl.value = `${today.getFullYear()}-${p(today.getMonth() + 1)}-01`;
        endDateFilterEl.value = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    }
    await updateDashboard();
}

async function updateDashboard() {
    const root = cmEnsureRoot();
    const startMs = cmParseDay(startDateFilterEl.value, false);
    const endMs = cmParseDay(endDateFilterEl.value, true);
    if (startMs === null || endMs === null) { root.innerHTML = `<div class="cm-note cm-warn">Pick a start and end date.</div>`; return; }
    if (endMs < startMs) { root.innerHTML = `<div class="cm-note cm-warn">End date is before the start date.</div>`; return; }

    const cacheKey = `${startMs}-${endMs}`;
    try {
        if (!cmEventsCache || cmEventsCache.key !== cacheKey) {
            toggleLoading(true, 'Loading grading activity...');
            const snap = await fbFirestore.collection('gradingEvents')
                .where('timestamp', '>=', firebase.firestore.Timestamp.fromMillis(startMs))
                .where('timestamp', '<=', firebase.firestore.Timestamp.fromMillis(endMs))
                .get();
            const events: CmEvent[] = [];
            snap.docs.forEach((d: any) => { const e = cmNormalizeEvent(d.id, d.data()); if (e) events.push(e); });
            cmEventsCache = { key: cacheKey, events };
        }
        await cmLoadSchoolList();
        const nameById = new Map<string, string>(cmSchoolList.map(s => [s.uid, s.schoolName] as [string, string]));
        cmLastResult = cmAggregate(cmEventsCache.events, schoolFilterEl.value, nameById);
        cmRender();
    } catch (error: any) {
        console.error('[CostAnalytics] load failed', error);
        const denied = error?.code === 'permission-denied';
        root.innerHTML = `<div class="cm-note cm-warn"><strong>Could not load grading activity.</strong><br>${cmEsc(error?.message || error)}${denied
            ? '<br>The <code>gradingEvents</code> collection is not readable by this account — add a Firestore rule allowing the super admin to read it.' : ''}</div>`;
    } finally {
        toggleLoading(false);
    }
}

function cmKpi(label: string, value: string, sub: string, color: string): string {
    return `<div class="cm-kpi" style="--c:${color}"><div class="l">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;
}

function cmSorted(table: 'school' | 'teacher' | 'day', rows: CmRow[]): CmRow[] {
    const { key, dir } = cmSort[table];
    return [...rows].sort((a, b) => {
        const av: any = a[key], bv: any = b[key];
        const c = typeof av === 'string' ? av.localeCompare(bv) : (av - bv);
        return dir === 'asc' ? c : -c;
    });
}

function cmTable(table: 'school' | 'teacher' | 'day', rows: CmRow[], firstCol: string, showSub: boolean): string {
    const cols: { k: keyof CmRow; t: string }[] = [
        { k: 'pagesScanned', t: 'Pages scanned' }, { k: 'pagesGraded', t: 'Pages graded' }, { k: 'papers', t: 'Papers graded' },
        { k: 'gradings', t: 'Gradings run' }, { k: 'regradings', t: 'Re-gradings' }, { k: 'failed', t: 'Failed attempts' },
        { k: 'rescanPages', t: 'Re-scan pages' },
    ];
    if (table !== 'day') cols.push({ k: 'students', t: 'Students' });
    if (table === 'school') cols.push({ k: 'teachers', t: 'Teachers' });
    if (table === 'day') cols.push({ k: 'teachers', t: 'Teachers active' });
    cols.push({ k: 'last', t: 'Last activity' });
    const arrow = (k: keyof CmRow) => cmSort[table].key === k ? (cmSort[table].dir === 'asc' ? ' ▲' : ' ▼') : '';
    const head = `<tr><th class="cm-sort" data-table="${table}" data-key="name">${firstCol}${arrow('name')}</th>${showSub ? '<th>School</th>' : ''}` +
        cols.map(c => `<th class="cm-sort" data-table="${table}" data-key="${c.k}">${c.t}${arrow(c.k)}</th>`).join('') + '</tr>';
    const body = rows.map(r => {
        const nameCell = table === 'school'
            ? `<a href="#" class="cm-school-link" data-id="${cmEsc(r.key)}">${cmEsc(r.name)}</a>` : cmEsc(r.name);
        return `<tr><td style="font-weight:600">${nameCell}</td>${showSub ? `<td>${cmEsc(r.sub)}</td>` : ''}` +
            cols.map(c => {
                if (c.k === 'last') return `<td>${cmWhen(r.last)}</td>`;
                const v = r[c.k] as number;
                const cls = (c.k === 'failed' || c.k === 'rescanPages') && v > 0 ? 'n warn' : 'n';
                return `<td class="${cls}">${cmNum(v)}</td>`;
            }).join('') + '</tr>';
    }).join('') || `<tr><td colspan="${cols.length + 1 + (showSub ? 1 : 0)}" style="text-align:center;color:#888;padding:18px">No activity in this range.</td></tr>`;
    return `<div class="table-container"><table class="data-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function cmRender() {
    const root = cmEnsureRoot();
    const r = cmLastResult;
    if (!r) return;
    const t = r.totals;
    const totalSchools = cmSchoolList.length;
    const schoolSearch = (document.getElementById('cm-school-search') as HTMLInputElement | null)?.value.toLowerCase() || '';
    const teacherSearch = (document.getElementById('cm-teacher-search') as HTMLInputElement | null)?.value.toLowerCase() || '';

    const trackedNote = r.regradeTrackedSince
        ? `Re-grade tracking is live from ${cmWhen(r.regradeTrackedSince)}; earlier history shows failed attempts only.`
        : `Re-grade tracking has no data yet — earlier history shows failed attempts only.`;

    const emptyBanner = r.eventCount === 0
        ? `<div class="cm-note cm-warn"><strong>No grading activity recorded for this selection.</strong> If you expected data: the tracker functions must be deployed and the history backfill run once (see vertex-ai-backend/gradingStats.js).</div>` : '';

    const schoolRows = cmSorted('school', r.bySchool).filter(x => !schoolSearch || x.name.toLowerCase().includes(schoolSearch));
    const teacherAll = cmSorted('teacher', r.byTeacher).filter(x => !teacherSearch || x.name.toLowerCase().includes(teacherSearch) || x.sub.toLowerCase().includes(teacherSearch));
    const teacherRows = teacherAll.slice(0, CM_PAGE_LIMIT.teacher);

    root.innerHTML = `
      ${emptyBanner}
      <div class="cm-kpis">
        ${cmKpi('Schools active', cmNum(r.schoolsActive), `of ${cmNum(totalSchools)} onboarded`, '#6a11cb')}
        ${cmKpi('Teachers active', cmNum(t.teachers), 'graded or tried to grade', '#2575fc')}
        ${cmKpi('Pages scanned', cmNum(t.pagesScanned), 'every attempt: graded + re-graded + failed', '#6a11cb')}
        ${cmKpi('Pages graded', cmNum(t.pagesGraded), 'unique papers, each counted once', '#198754')}
        ${cmKpi('Papers graded', cmNum(t.papers), `${cmNum(t.students)} students`, '#198754')}
        ${cmKpi('Gradings run', cmNum(t.gradings), 'completed grading runs', '#2575fc')}
        ${cmKpi('Re-gradings', cmNum(t.regradings), 'papers graded again after a first grading', '#fd7e14')}
        ${cmKpi('Failed attempts', cmNum(t.failed), `${cmNum(t.failedPages)} pages in jobs that errored and were re-run`, '#dc3545')}
        ${cmKpi('Re-scan pages', cmNum(t.rescanPages), 'pages scanned beyond unique graded pages', '#dc3545')}
      </div>
      <div class="cm-note">${cmEsc(trackedNote)} "Pages scanned" counts every page the system had to read, including papers that were re-graded or failed and were run again. Latest activity: ${cmWhen(t.last)}.</div>

      <div class="cm-card">
        <div class="cm-head"><h3>By school</h3>
          <input id="cm-school-search" placeholder="Search school…" value="${cmEsc(schoolSearch)}">
          <button type="button" class="button-secondary" id="cm-csv-school"><i class="fas fa-download"></i> CSV</button></div>
        ${cmTable('school', schoolRows, 'School', false)}
      </div>

      <div class="cm-card">
        <div class="cm-head"><h3>By teacher${teacherAll.length > CM_PAGE_LIMIT.teacher ? ` <span style="font-weight:400;font-size:.8rem;color:#888">(top ${CM_PAGE_LIMIT.teacher} of ${teacherAll.length})</span>` : ''}</h3>
          <input id="cm-teacher-search" placeholder="Search teacher or school…" value="${cmEsc(teacherSearch)}">
          <button type="button" class="button-secondary" id="cm-csv-teacher"><i class="fas fa-download"></i> CSV</button></div>
        ${cmTable('teacher', teacherRows, 'Teacher', true)}
      </div>

      <div class="cm-card">
        <div class="cm-head"><h3>By day</h3>
          <button type="button" class="button-secondary" id="cm-csv-day"><i class="fas fa-download"></i> CSV</button></div>
        ${cmTable('day', cmSorted('day', r.byDay), 'Date', false)}
      </div>`;

    // wiring
    root.querySelectorAll<HTMLElement>('th.cm-sort').forEach(th => th.addEventListener('click', () => {
        const table = th.dataset.table as 'school' | 'teacher' | 'day';
        const key = th.dataset.key as keyof CmRow;
        const cur = cmSort[table];
        cmSort[table] = { key, dir: cur.key === key && cur.dir === 'desc' ? 'asc' : 'desc' };
        cmRender();
    }));
    root.querySelectorAll<HTMLAnchorElement>('a.cm-school-link').forEach(a => a.addEventListener('click', ev => {
        ev.preventDefault();
        const id = a.dataset.id || '';
        if (Array.from(schoolFilterEl.options).some(o => o.value === id)) { schoolFilterEl.value = id; updateDashboard(); }
    }));
    const keepFocus = (id: string) => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        el?.addEventListener('input', () => {
            const pos = el.selectionStart; cmRender();
            const again = document.getElementById(id) as HTMLInputElement | null;
            if (again) { again.focus(); again.setSelectionRange(pos, pos); }
        });
    };
    keepFocus('cm-school-search'); keepFocus('cm-teacher-search');
    document.getElementById('cm-csv-school')?.addEventListener('click', () => cmCsv('school', 'School', r.bySchool, false));
    document.getElementById('cm-csv-teacher')?.addEventListener('click', () => cmCsv('teacher', 'Teacher', r.byTeacher, true));
    document.getElementById('cm-csv-day')?.addEventListener('click', () => cmCsv('day', 'Date', r.byDay, false));
}

function cmCsv(table: 'school' | 'teacher' | 'day', firstCol: string, rows: CmRow[], withSchool: boolean) {
    const head = [firstCol, ...(withSchool ? ['School'] : []), 'Pages scanned', 'Pages graded', 'Papers graded', 'Gradings run',
        'Re-gradings', 'Failed attempts', 'Re-scan pages', 'Students', 'Teachers', 'Last activity'];
    const q = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head.map(q).join(',')];
    cmSorted(table, rows).forEach(r => lines.push([
        r.name, ...(withSchool ? [r.sub] : []), r.pagesScanned, r.pagesGraded, r.papers, r.gradings, r.regradings,
        r.failed, r.rescanPages, r.students, r.teachers, r.last ? new Date(r.last).toISOString() : '',
    ].map(q).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `grading-activity-by-${table}-${startDateFilterEl.value}_to_${endDateFilterEl.value}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Names other parts of the app (setupEventListeners) still call:
function renderAllTables(_resetPage = true) { cmRender(); }
function renderKpiCards() { cmRender(); }
function renderCharts() { /* removed */ }
function renderLogTable() { /* the raw API-call log table was removed with the token widgets */ }
