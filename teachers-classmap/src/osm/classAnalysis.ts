// Class analysis: built only from the reports that already exist (the teachers' marks + the topic/concept tags on each question).
// No AI call, no cost - it just adds up what each student's own Learning Summary already says, for the whole class.
import { computeLearn, LC } from './learn';

const esc = (v: any) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colOf = (pct: number) => pct >= 80 ? LC.green : pct >= 50 ? LC.amber : LC.red;
const bgOf = (pct: number) => pct >= 80 ? '#d9f3e6' : pct >= 50 ? '#fff0d6' : '#fde1e3';
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface AnStudent { uid: string; name: string; roll: string; score: number | null; max: number; reports: any[] | null }
export interface AnCtx { title: string; sub: string; students: AnStudent[]; onBack: () => void; onOpen?: (uid: string) => void }

type StuTopic = { uid: string; name: string; pct: number; scored: number; max: number; nQ: number; nWeak: number };
type ConceptAgg = { name: string; have: number; weak: number; weakNames: string[] };
type TopicAgg = { name: string; scored: number; max: number; pct: number; students: StuTopic[]; concepts: ConceptAgg[]; below50: number; below80: number };

export function buildAnalysis(students: AnStudent[]) {
    const done = students.filter(s => s.reports && s.reports.length);
    const per = done.map(s => {
        const L = computeLearn(s.reports!);
        const scored = L.topics.reduce((a, t) => a + t.scored, 0), max = L.topics.reduce((a, t) => a + t.max, 0);
        return { s, L, scored, max, pct: max ? Math.round(scored / max * 100) : 0 };
    });
    const tm = new Map<string, TopicAgg & { cm: Map<string, ConceptAgg> }>();
    per.forEach(({ s, L }) => L.topics.forEach(t => {
        if (!tm.has(t.name)) tm.set(t.name, { name: t.name, scored: 0, max: 0, pct: 0, students: [], concepts: [], below50: 0, below80: 0, cm: new Map() });
        const a = tm.get(t.name)!; a.scored += t.scored; a.max += t.max;
        a.students.push({ uid: s.uid, name: s.name, pct: t.pct, scored: t.scored, max: t.max, nQ: t.nQ, nWeak: t.nWeak });
        if (t.pct < 50) a.below50++; if (t.pct < 80) a.below80++;
        t.concepts.forEach(c => {
            if (!a.cm.has(c.name)) a.cm.set(c.name, { name: c.name, have: 0, weak: 0, weakNames: [] });
            const x = a.cm.get(c.name)!; x.have++; if (c.nWeak > 0) { x.weak++; x.weakNames.push(s.name); }
        });
    }));
    const topics: TopicAgg[] = [...tm.values()].map(a => {
        a.pct = a.max ? Math.round(a.scored / a.max * 100) : 0;
        a.concepts = [...a.cm.values()].sort((x, y) => (y.weak / y.have) - (x.weak / x.have) || y.weak - x.weak);
        a.students.sort((x, y) => x.pct - y.pct);
        const { cm, ...rest } = a as any; return rest as TopicAgg;
    }).sort((a, b) => a.pct - b.pct || b.below50 - a.below50);
    // question by question
    const qm = new Map<string, { q: string; topic: string; got: number; max: number; zero: number; n: number }>();
    per.forEach(({ s }) => (s.reports || []).forEach((r: any) => {
        if (r._runtimeOrLoser || r._unattemptedAlt) return;
        const k = String(r.questionNumber); if (!qm.has(k)) qm.set(k, { q: k, topic: String(r.topic || r.concept || ''), got: 0, max: 0, zero: 0, n: 0 });
        const e = qm.get(k)!; const g = Number(r.marksAwarded) || 0; e.got += g; e.max += Number(r.maxMarksForQuestion) || 0; e.n++; if (g <= 0) e.zero++;
    }));
    const qs = [...qm.values()].map(e => ({ ...e, pct: e.max ? Math.round(e.got / e.max * 100) : 0 })).filter(e => e.n >= 2).sort((a, b) => a.pct - b.pct);
    const pcts = per.map(p => p.pct);
    const avg = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0;
    return { done, per, topics, qs, avg, hi: pcts.length ? Math.max(...pcts) : 0, lo: pcts.length ? Math.min(...pcts) : 0, support: per.filter(p => p.pct < 50).length };
}

let styled = false;
function style() {
    if (styled || document.getElementById('osm-an-style')) return; styled = true;
    const st = document.createElement('style'); st.id = 'osm-an-style';
    st.textContent = `
.osm-an{max-width:1280px;margin:0 auto;padding:18px 22px 60px;display:flex;flex-direction:column;gap:20px}
.osm-an h3{margin:0 0 4px;font-size:1.02rem;color:#1a1f6e;font-weight:600}.osm-an .anote{font-size:.8rem;color:var(--osm-muted);margin:0 0 12px}
.osm-an-card{background:var(--osm-card);border:1px solid var(--osm-line);border-radius:18px;padding:18px 20px;box-shadow:var(--osm-shadow)}
.osm-an-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.osm-an-kpi{background:var(--osm-card);border:1px solid var(--osm-line);border-radius:16px;padding:12px 16px;box-shadow:var(--osm-shadow)}
.osm-an-kpi b{display:block;font-size:1.6rem;line-height:1.2;background:var(--osm-grad);-webkit-background-clip:text;background-clip:text;color:transparent}.osm-an-kpi b.r{background:none;color:#d12f3a;-webkit-text-fill-color:#d12f3a}
.osm-an-kpi span{font-size:.76rem;color:var(--osm-muted)}
.osm-an-trow{display:grid;grid-template-columns:minmax(150px,26%) 1fr 74px;gap:14px;align-items:center;padding:9px 0;border-bottom:1px solid var(--osm-line);cursor:pointer}
.osm-an-trow:last-child{border-bottom:0}.osm-an-trow:hover{background:#fafbff}
.osm-an-tn{font-weight:600;font-size:.9rem;line-height:1.25}.osm-an-ts{font-size:.76rem;color:var(--osm-muted);margin-top:2px}
.osm-an-bar{height:12px;border-radius:7px;background:#eef0f7;overflow:hidden;display:flex}.osm-an-bar i{display:block;height:100%}
.osm-an-pill{text-align:center;color:#fff;font-weight:700;font-size:.85rem;border-radius:99px;padding:4px 0}
.osm-an-detail{grid-column:1/-1;background:#f8faff;border-radius:12px;padding:12px 14px;margin:6px 0 2px;display:none;cursor:default}
.osm-an-trow.open .osm-an-detail{display:block}
.osm-an-detail h4{margin:8px 0 6px;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:#5b6b86}.osm-an-detail h4:first-child{margin-top:0}
.osm-an-cr{display:flex;justify-content:space-between;gap:10px;font-size:.84rem;padding:4px 0;border-bottom:1px dashed var(--osm-line)}.osm-an-cr:last-child{border-bottom:0}
.osm-an-cr small{color:var(--osm-muted);display:block;font-size:.74rem}
.osm-an-chip{display:inline-block;border-radius:99px;padding:2px 10px;margin:2px 4px 2px 0;font-size:.78rem;font-weight:500;border:1px solid}
.osm-an-wrap{overflow:auto;border:1px solid var(--osm-line);border-radius:14px;max-height:70vh}
.osm-an-heat{border-collapse:separate;border-spacing:0;font-size:.8rem;min-width:100%}
.osm-an-heat th,.osm-an-heat td{padding:7px 9px;text-align:center;border-bottom:1px solid #fff;border-right:1px solid #fff;white-space:nowrap}
.osm-an-heat thead th{position:sticky;top:0;background:var(--osm-soft);z-index:2;font-weight:600;color:#5b6b86;font-size:.72rem;max-width:130px;white-space:normal;line-height:1.2;vertical-align:bottom}
.osm-an-heat td:first-child,.osm-an-heat th:first-child{position:sticky;left:0;text-align:left;background:#fff;z-index:1;font-weight:500;min-width:170px}.osm-an-heat thead th:first-child{background:var(--osm-soft);z-index:3}
.osm-an-heat td.na{color:#b4bccb;background:#f6f7fa}
.osm-an-ctl{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.osm-an-ctl select,.osm-an-ctl input{border:1px solid var(--osm-line);border-radius:10px;padding:7px 10px;font-family:inherit;font-size:.85rem;background:#fff;color:var(--osm-fg)}
.osm-an-stu{display:grid;grid-template-columns:minmax(160px,24%) 70px 1fr;gap:12px;align-items:center;padding:9px 0;border-bottom:1px solid var(--osm-line);font-size:.86rem}
.osm-an-stu:last-child{border-bottom:0}.osm-an-stu.na{opacity:.55}
.osm-an-q{display:grid;grid-template-columns:70px 1fr 56px;gap:12px;align-items:center;padding:6px 0;font-size:.84rem}
.osm-an-hist{display:flex;align-items:flex-end;gap:8px;height:90px}.osm-an-hist div{flex:1;text-align:center;font-size:.72rem;color:var(--osm-muted)}.osm-an-hist i{display:block;border-radius:6px 6px 0 0;margin-bottom:3px;min-height:2px}
@media(max-width:720px){.osm-an{padding:12px 12px 50px}.osm-an-trow{grid-template-columns:1fr 60px}.osm-an-trow .osm-an-bar{grid-column:1/-1;order:3}.osm-an-stu{grid-template-columns:1fr 56px}.osm-an-stu .osm-an-chips{grid-column:1/-1}}
`;
    document.head.appendChild(st);
}

export function renderClassAnalysis(host: HTMLElement, ctx: AnCtx) {
    style();
    const A = buildAnalysis(ctx.students);
    const total = ctx.students.length, nDone = A.done.length;
    if (!nDone) {
        host.innerHTML = `<div class="osm-an"><div class="osm-an-card" style="text-align:center;padding:50px 20px;"><h3>No analysed reports yet</h3><p class="anote">The class analysis appears as soon as at least one student's sheet has been analysed. ${total} students are on this paper.</p></div></div>`;
        return;
    }
    const attention = A.topics.filter(t => t.pct < 70);
    const tHeads = A.topics;
    // ---- score spread
    const bins = [['0–39', 0, 39], ['40–49', 40, 49], ['50–59', 50, 59], ['60–69', 60, 69], ['70–79', 70, 79], ['80–89', 80, 89], ['90–100', 90, 100]] as [string, number, number][];
    const counts = bins.map(([, lo, hi]) => A.per.filter(p => p.pct >= lo && p.pct <= hi).length); const mx = Math.max(1, ...counts);
    const hist = `<div class="osm-an-hist">${bins.map(([l, lo], i) => `<div><span>${counts[i]}</span><i style="height:${Math.max(2, counts[i] / mx * 64)}px;background:${colOf(lo + 5)}"></i>${l}</div>`).join('')}</div>`;
    // ---- topic rows
    const topicRow = (t: TopicAgg, i: number) => {
        const weakC = t.concepts.filter(c => c.weak > 0);
        const needs = t.students.filter(s => s.pct < 80);
        return `<div class="osm-an-trow" data-i="${i}">
          <div><div class="osm-an-tn">${esc(t.name)}</div><div class="osm-an-ts">${t.below50} of ${t.students.length} students below 50% · ${t.below80} below 80%</div></div>
          <div class="osm-an-bar" title="class average ${t.pct}%"><i style="width:${t.pct}%;background:${colOf(t.pct)}"></i></div>
          <div class="osm-an-pill" style="background:${colOf(t.pct)}">${t.pct}%</div>
          <div class="osm-an-detail">
            <h4>Revise these ideas (share of students who lost marks)</h4>
            ${weakC.length ? weakC.slice(0, 12).map(c => { const p = Math.round(c.weak / c.have * 100); return `<div class="osm-an-cr"><div>${esc(c.name)}<small>${esc(c.weakNames.slice(0, 8).join(', '))}${c.weakNames.length > 8 ? ` +${c.weakNames.length - 8} more` : ''}</small></div><b style="color:${colOf(100 - p)}">${p}% · ${c.weak}/${c.have}</b></div>`; }).join('') : '<div class="osm-an-ts">Nobody lost marks on this topic.</div>'}
            <h4>Students who need help here (${needs.length})</h4>
            <div>${needs.length ? needs.map(s => `<span class="osm-an-chip" style="color:${colOf(s.pct)};border-color:${colOf(s.pct)};background:${bgOf(s.pct)}">${esc(s.name)} · ${s.pct}%</span>`).join('') : '<span class="osm-an-ts">Everyone is at 80% or more.</span>'}</div>
          </div></div>`;
    };
    const strong = A.topics.filter(t => t.pct >= 80).slice().reverse();
    // ---- heatmap
    const heatRows = (sort: string) => {
        const rows = ctx.students.map(s => { const p = A.per.find(x => x.s.uid === s.uid); return { s, p }; });
        rows.sort((a, b) => sort === 'low' ? ((a.p?.pct ?? 999) - (b.p?.pct ?? 999)) : sort === 'high' ? ((b.p?.pct ?? -1) - (a.p?.pct ?? -1)) : sort === 'roll' ? String(a.s.roll).localeCompare(String(b.s.roll), undefined, { numeric: true }) : a.s.name.localeCompare(b.s.name));
        return rows;
    };
    const heat = (sort: string) => `<table class="osm-an-heat"><thead><tr><th>Student</th><th>Total</th>${tHeads.map(t => `<th title="${esc(t.name)}">${esc(t.name)}<br><span style="color:${colOf(t.pct)}">${t.pct}%</span></th>`).join('')}</tr></thead><tbody>${heatRows(sort).map(({ s, p }) => {
        if (!p) return `<tr><td>${esc(s.name)}</td><td class="na" colspan="${tHeads.length + 1}" style="text-align:left">not analysed yet</td></tr>`;
        const m = new Map(p.L.topics.map(t => [t.name, t]));
        return `<tr><td>${esc(s.name)}</td><td style="background:${bgOf(p.pct)};color:${colOf(p.pct)};font-weight:700">${p.pct}%</td>${tHeads.map(t => { const x = m.get(t.name); return x ? `<td style="background:${bgOf(x.pct)};color:${colOf(x.pct)};font-weight:600" title="${esc(t.name)}: ${r1(x.scored)}/${r1(x.max)}">${x.pct}</td>` : '<td class="na">–</td>'; }).join('')}</tr>`;
    }).join('')}</tbody></table>`;
    // ---- student by student
    const stuList = (q: string, sort: string) => heatRows(sort).filter(({ s }) => !q || s.name.toLowerCase().includes(q) || String(s.roll).includes(q)).map(({ s, p }) => {
        if (!p) return `<div class="osm-an-stu na"><div><b>${esc(s.name)}</b><div class="osm-an-ts">Roll ${esc(s.roll)}</div></div><div>–</div><div class="osm-an-ts">Not analysed yet - appears here once the sheet is analysed.</div></div>`;
        const weak = p.L.topics.filter(t => t.pct < 80).sort((a, b) => a.pct - b.pct), good = p.L.topics.filter(t => t.pct >= 80);
        return `<div class="osm-an-stu"><div><b>${ctx.onOpen ? `<a href="#" class="osm-an-open" data-uid="${esc(s.uid)}" style="color:inherit;text-decoration:underline dotted">${esc(s.name)}</a>` : esc(s.name)}</b><div class="osm-an-ts">Roll ${esc(s.roll)} · ${r1(p.scored)}/${r1(p.max)}</div></div>
          <div class="osm-an-pill" style="background:${colOf(p.pct)}">${p.pct}%</div>
          <div class="osm-an-chips">${weak.length ? weak.map(t => `<span class="osm-an-chip" style="color:${colOf(t.pct)};border-color:${colOf(t.pct)};background:${bgOf(t.pct)}">${esc(t.name)} ${t.pct}%</span>`).join('') : '<span class="osm-an-ts">Strong in every topic.</span>'}${good.length ? `<div class="osm-an-ts" style="margin-top:3px">Strong: ${esc(good.map(t => t.name).join(', '))}</div>` : ''}</div></div>`;
    }).join('') || '<div class="osm-an-ts">No student matches.</div>';
    // ---- hardest questions
    const hardest = A.qs.slice(0, 10);
    host.innerHTML = `<div class="osm-an">
      <div class="osm-an-kpis">
        <div class="osm-an-kpi"><b>${nDone}<small style="font-size:.9rem;color:var(--osm-muted);-webkit-text-fill-color:var(--osm-muted)">/${total}</small></b><span>students analysed${nDone < total ? ' (rest are left out)' : ''}</span></div>
        <div class="osm-an-kpi"><b>${A.avg}%</b><span>class average</span></div>
        <div class="osm-an-kpi"><b>${A.hi}% / ${A.lo}%</b><span>highest / lowest</span></div>
        <div class="osm-an-kpi"><b class="${A.support ? 'r' : ''}">${A.support}</b><span>students below 50%</span></div>
        <div class="osm-an-kpi"><b class="${attention.length ? 'r' : ''}">${attention.length}</b><span>topics to re-teach (class under 70%)</span></div>
      </div>
      <div class="osm-an-card"><h3>Topics to touch up again</h3><p class="anote">Weakest first. Tap a topic to see which ideas inside it were missed and which students need help. Percentages are marks scored ÷ marks available in that topic, across all analysed students.</p>${A.topics.map(topicRow).join('')}</div>
      <div class="osm-an-card"><h3>What the class did well</h3><p class="anote">Topics where the class scored 80% or more.</p>${strong.length ? strong.map(t => `<span class="osm-an-chip" style="color:${LC.green};border-color:${LC.green};background:#d9f3e6">${esc(t.name)} · ${t.pct}%</span>`).join('') : '<span class="osm-an-ts">No topic is at 80% yet.</span>'}</div>
      <div class="osm-an-card"><h3>Score spread</h3><p class="anote">How many students fall in each percentage band.</p>${hist}</div>
      <div class="osm-an-card"><h3>Every student × every topic</h3><p class="anote">Each cell is that student's % in the topic. Green 80+, amber 50–79, red below 50. Column headings show the class average.</p>
        <div class="osm-an-ctl"><label class="osm-an-ts">Sort rows</label><select id="osm-an-hsort"><option value="name">Student name A–Z</option><option value="low">Lowest total first</option><option value="high">Highest total first</option><option value="roll">Roll number</option></select><button class="osm-btn small" id="osm-an-csv">Download as spreadsheet</button></div>
        <div class="osm-an-wrap" id="osm-an-heat">${heat('name')}</div></div>
      <div class="osm-an-card"><h3>Student by student: who is weak at what</h3><p class="anote">Red and amber chips are the topics each student still needs work on.</p>
        <div class="osm-an-ctl"><input id="osm-an-q" placeholder="Search name or roll…"><select id="osm-an-ssort"><option value="name">Student name A–Z</option><option value="low">Lowest total first</option><option value="high">Highest total first</option><option value="roll">Roll number</option></select></div>
        <div id="osm-an-stu">${stuList('', 'name')}</div></div>
      <div class="osm-an-card"><h3>Questions most students missed</h3><p class="anote">Lowest class score first. Worth re-explaining in class.</p>${hardest.map(q => `<div class="osm-an-q"><b>Q${esc(q.q)}</b><div><div class="osm-an-bar"><i style="width:${q.pct}%;background:${colOf(q.pct)}"></i></div><div class="osm-an-ts">${esc(q.topic)} · ${q.zero} of ${q.n} scored zero</div></div><div class="osm-an-pill" style="background:${colOf(q.pct)}">${q.pct}%</div></div>`).join('') || '<span class="osm-an-ts">Not enough analysed students yet.</span>'}</div>
    </div>`;
    // ---- wiring
    host.querySelectorAll<HTMLElement>('.osm-an-trow').forEach(r => r.addEventListener('click', e => { if ((e.target as HTMLElement).closest('.osm-an-detail')) return; r.classList.toggle('open'); }));
    const heatEl = host.querySelector('#osm-an-heat') as HTMLElement;
    host.querySelector('#osm-an-hsort')?.addEventListener('change', e => { heatEl.innerHTML = heat((e.target as HTMLSelectElement).value); });
    const stuEl = host.querySelector('#osm-an-stu') as HTMLElement; const qEl = host.querySelector('#osm-an-q') as HTMLInputElement; const sEl = host.querySelector('#osm-an-ssort') as HTMLSelectElement;
    const redo = () => { stuEl.innerHTML = stuList(qEl.value.trim().toLowerCase(), sEl.value); wireOpen(); };
    const wireOpen = () => stuEl.querySelectorAll<HTMLElement>('.osm-an-open').forEach(a => a.addEventListener('click', e => { e.preventDefault(); ctx.onOpen?.(a.dataset.uid!); }));
    qEl.addEventListener('input', redo); sEl.addEventListener('change', redo); wireOpen();
    host.querySelector('#osm-an-csv')?.addEventListener('click', () => {
        const q = (v: any) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
        const lines = [['Roll', 'Student', 'Total %', ...tHeads.map(t => t.name + ' %')].map(q).join(',')];
        heatRows('roll').forEach(({ s, p }) => { const m = new Map((p?.L.topics || []).map(t => [t.name, t])); lines.push([s.roll, s.name, p ? p.pct : 'not analysed', ...tHeads.map(t => m.get(t.name)?.pct ?? '')].map(q).join(',')); });
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })); a.download = 'class-analysis.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
}
