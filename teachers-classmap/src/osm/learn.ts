// Learning summary: topic-by-topic results worked out from the teachers' marks (never from the AI), plus the HTML for them.
// Used by BOTH the teacher's Feedback tab and the Analysis PDF, so they always look and count the same.
// Topic = the broad level (report.concept, e.g. "Motion"); concept = the small idea inside it (report.topic, e.g. "Equations of motion").

export const LC = { green: '#1e8e4e', amber: '#d17a0a', red: '#d12f3a' };
const colOf = (pct: number) => pct >= 80 ? LC.green : pct >= 50 ? LC.amber : LC.red;
const esc = (v: any) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n1 = (n: number) => String(Math.round(n * 100) / 100);

export type LConcept = { name: string; nQ: number; nWeak: number; qs: string[]; weakQs: string[]; col: string };
export type LTopic = { name: string; nQ: number; nFull: number; nPart: number; nZero: number; nWeak: number; scored: number; max: number; pct: number; col: string; concepts: LConcept[] };

export function computeLearn(reports: any[]): { topics: LTopic[]; good: LTopic[]; improve: LTopic[] } {
    const counted = (reports || []).filter(r => !r._runtimeOrLoser && !r._unattemptedAlt);   // unchosen alternatives / "not attempted" never count for or against the student
    const map = new Map<string, { t: LTopic; c: Map<string, LConcept> }>();
    counted.forEach(r => {
        const tn = String(r.concept || r.topic || 'Other').trim() || 'Other'; const cn = String(r.topic || r.concept || tn).trim() || tn;
        const got = Number(r.marksAwarded) || 0, max = Number(r.maxMarksForQuestion) || 0;
        if (!map.has(tn)) map.set(tn, { t: { name: tn, nQ: 0, nFull: 0, nPart: 0, nZero: 0, nWeak: 0, scored: 0, max: 0, pct: 0, col: LC.green, concepts: [] }, c: new Map() });
        const e = map.get(tn)!; e.t.nQ++; e.t.scored += got; e.t.max += max;
        const full = max > 0 ? got >= max : got > 0; const zero = got <= 0;
        if (full) e.t.nFull++; else if (zero) e.t.nZero++; else e.t.nPart++;
        if (!e.c.has(cn)) e.c.set(cn, { name: cn, nQ: 0, nWeak: 0, qs: [], weakQs: [], col: LC.green });
        const cc = e.c.get(cn)!; cc.nQ++; cc.qs.push(String(r.questionNumber)); if (!full) { cc.nWeak++; cc.weakQs.push(String(r.questionNumber)); }
    });
    const topics: LTopic[] = [...map.values()].map(({ t, c }) => {
        t.nWeak = t.nPart + t.nZero; t.pct = t.max ? Math.round(t.scored / t.max * 100) : 0; t.col = colOf(t.pct);
        t.concepts = [...c.values()].map(x => ({ ...x, col: x.nWeak === 0 ? LC.green : x.nWeak >= x.nQ ? LC.red : LC.amber })).sort((a, b) => (b.nWeak / b.nQ) - (a.nWeak / a.nQ) || b.nWeak - a.nWeak);
        return t;
    }).sort((a, b) => b.pct - a.pct || b.max - a.max);
    return { topics, good: topics.filter(t => t.pct >= 80), improve: topics.filter(t => t.pct < 80).sort((a, b) => a.pct - b.pct || b.nWeak - a.nWeak) };
}

// "Motion: Do 5 problems…" -> { topic, step }
const splitStep = (s: any): { topic: string; step: string } => {
    if (s && typeof s === 'object') return { topic: String(s.concept || s.topic || ''), step: String(s.step || s.text || '') };
    const t = String(s ?? ''); const i = t.indexOf(': '); return i > 0 && i < 60 ? { topic: t.slice(0, i), step: t.slice(i + 2) } : { topic: '', step: t };
};

// Blocks of the learning summary, each a self-contained HTML string (inline styles only, so they print the same in the PDF).
export function learnBlocks(L: ReturnType<typeof computeLearn>, o: { fs: number; steps?: any[]; summary?: string }): { kind: string; html: string }[] {
    const fs = o.fs; const out: { kind: string; html: string }[] = [];
    const sect = (t: string, sub: string) => `<div style="margin:${fs * 1.3}px 0 ${fs * .45}px;font-size:${fs * .95}px;letter-spacing:1px;font-weight:700;color:#1a1f6e;">${t}${sub ? ` <span style="font-weight:400;color:#7f8c8d;letter-spacing:0;font-size:${fs * .9}px;">${sub}</span>` : ''}</div>`;
    const chip = (txt: string, col: string) => `<span style="display:inline-block;border:1.5px solid ${col};color:${col};background:#fff;border-radius:99px;padding:${fs * .25}px ${fs * .8}px;margin:0 ${fs * .4}px ${fs * .4}px 0;font-size:${fs * .95}px;font-weight:600;">${esc(txt)}</span>`;
    if (o.summary) out.push({ kind: 'summary', html: `<div style="font-size:${fs}px;line-height:1.55;background:#eaf7ef;border-radius:10px;padding:${fs * .8}px ${fs * 1.2}px;color:#17613a;">${esc(o.summary)}</div>` });
    if (!L.topics.length) return out;
    // 1) topic by topic, strongest first
    const row = (t: LTopic) => {
        const w = (n: number) => (t.nQ ? n / t.nQ * 100 : 0).toFixed(1);
        const parts = [`${t.nFull} of ${t.nQ} fully right`, t.nPart ? `${t.nPart} partly right` : '', t.nZero ? `${t.nZero} missed` : ''].filter(Boolean).join(' · ');
        return `<div style="display:flex;align-items:center;gap:${fs}px;margin:${fs * .55}px 0;"><div style="width:30%;font-weight:600;font-size:${fs}px;line-height:1.25;">${esc(t.name)}</div>
          <div style="flex:1;"><div style="display:flex;height:${fs * .85}px;border-radius:6px;overflow:hidden;background:#eef0f7;"><i style="width:${w(t.nFull)}%;background:${LC.green};"></i><i style="width:${w(t.nPart)}%;background:#f2a900;"></i><i style="width:${w(t.nZero)}%;background:${LC.red};"></i></div>
          <div style="font-size:${fs * .82}px;color:#6b7280;margin-top:${fs * .2}px;">${parts}</div></div>
          <div style="width:${fs * 4.2}px;text-align:center;font-weight:700;font-size:${fs * .95}px;color:#fff;background:${t.col};border-radius:99px;padding:${fs * .25}px 0;">${t.pct}%</div></div>`;
    };
    out.push({ kind: 'head1', html: sect('TOPIC BY TOPIC', 'strongest first · each bar shows your questions: green fully right, yellow partly, red missed') + row(L.topics[0]) });
    L.topics.slice(1).forEach(t => out.push({ kind: 'row', html: row(t) }));
    // 2) what you did well
    if (L.good.length) out.push({ kind: 'good', html: sect('WHAT YOU DID WELL', 'topics where you scored 80% or more') + `<div>${L.good.map(t => chip(`${t.name} · ${t.nFull}/${t.nQ}`, LC.green)).join('')}</div>` });
    // 3) where to improve: topic -> weak concepts, weakest first
    if (L.improve.length) {
        out.push({ kind: 'imp-h', html: sect('WHERE TO IMPROVE', 'weakest topic first, with the ideas inside it that need work') });
        L.improve.forEach(t => {
            const weak = t.concepts.filter(c => c.nWeak > 0);
            out.push({ kind: 'imp', html: `<div style="border:1.5px solid ${t.col};border-radius:12px;padding:${fs * .7}px ${fs}px;margin:${fs * .5}px 0;background:#fff;">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:${fs}px;"><b style="font-size:${fs * 1.05}px;">${esc(t.name)}</b><span style="font-size:${fs * .9}px;font-weight:700;color:${t.col};white-space:nowrap;">${t.nWeak} of ${t.nQ} questions weak</span></div>
              ${weak.map(c => `<div style="display:flex;align-items:baseline;gap:${fs * .6}px;margin-top:${fs * .4}px;font-size:${fs}px;"><span style="color:${c.col};font-size:${fs * 1.1}px;line-height:1;">●</span><span style="flex:1;">${esc(c.name)}</span><span style="color:${c.col};font-weight:700;white-space:nowrap;">${c.nWeak} of ${c.nQ}</span><span style="color:#8a93a6;font-size:${fs * .85}px;white-space:nowrap;">${c.weakQs.map(q => 'Q' + esc(q)).join(', ')}</span></div>`).join('')}</div>` });
        });
    }
    // 4) next steps: a few short lines
    const steps = (o.steps || []).map(splitStep).filter(s => s.step).slice(0, 5);
    if (steps.length) {
        out.push({ kind: 'steps-h', html: sect('YOUR NEXT STEPS', '') });
        steps.forEach((s, i) => { const t = L.topics.find(x => x.name === s.topic); const col = t ? t.col : LC.green;
            out.push({ kind: 'step', html: `<div style="display:flex;gap:${fs * .8}px;align-items:center;border-left:4px solid ${col};background:#fff;border-radius:8px;padding:${fs * .5}px ${fs}px;margin:${fs * .4}px 0;font-size:${fs}px;box-shadow:0 0 0 1px #e3e6f3 inset;"><b style="color:${col};">${i + 1}</b>${s.topic ? `<span style="font-weight:700;color:${col};white-space:nowrap;">${esc(s.topic)}</span>` : ''}<span style="flex:1;">${esc(s.step)}</span></div>` }); });
    }
    return out;
}
export const learnNames = (L: ReturnType<typeof computeLearn>) => ({ strengths: L.good.map(t => t.name), improve: L.improve.map(t => t.name) });
export const _n1 = n1;
