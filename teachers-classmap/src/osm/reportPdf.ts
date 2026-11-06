// Shared by the teacher app and the student app: the full assessment report (score page, answer-sheet pages with question cards,
// learning summary) is built ONCE as pages of HTML. The same pages are shown on screen and rendered into the PDF, so they always match.
import { computeLearn, learnBlocks, learnNames } from './learn';

const _escH = (v: any) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let _osmMathFrame: Promise<any> | null = null;
function _osmMathEngine(): Promise<any> {
    if (_osmMathFrame) return _osmMathFrame;
    _osmMathFrame = new Promise((resolve, reject) => {
        const fr = document.createElement('iframe'); fr.style.cssText = 'position:fixed;left:-9999px;top:0;width:10px;height:10px;border:0;visibility:hidden;';
        fr.srcdoc = '<!doctype html><html><head><script>window.MathJax={loader:{load:["[tex]/ams","[tex]/cases"]},tex:{packages:{"[+]":["ams","cases"]}},svg:{fontCache:"none"}};<\/script><script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"><\/script></head><body></body></html>';
        fr.onload = () => { const t0 = Date.now(); const poll = () => { const mj = (fr.contentWindow as any)?.MathJax; if (mj?.startup?.promise) mj.startup.promise.then(() => resolve(mj)).catch(reject); else if (Date.now() - t0 > 20000) reject(new Error('MathJax svg load timeout')); else setTimeout(poll, 100); }; poll(); };
        document.body.appendChild(fr);
    });
    _osmMathFrame.catch(() => { _osmMathFrame = null; });
    return _osmMathFrame;
}
async function osmMathToHtml(text: any, opts: { maxChars?: number } = {}): Promise<string> {
    let t = String(text ?? '');
    const re = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;
    if (opts.maxChars && t.length > opts.maxChars) { // cut at a sentence end that is outside any formula
        let cut = -1; const ranges: number[][] = []; let m: RegExpExecArray | null; re.lastIndex = 0; while ((m = re.exec(t))) ranges.push([m.index, m.index + m[0].length]);
        for (let i = opts.maxChars; i > opts.maxChars * 0.5; i--) { if (/[.;]/.test(t[i]) && !ranges.some(r => i > r[0] && i < r[1])) { cut = i + 1; break; } }
        t = cut > 0 ? t.slice(0, cut) : t; }
    if (!/\\[(\[]/.test(t)) return _escH(t);
    let mj: any = null; try { mj = await _osmMathEngine(); } catch { /* fall back to readable text */ }
    let out = '', last = 0, m: RegExpExecArray | null; re.lastIndex = 0;
    while ((m = re.exec(t))) {
        out += _escH(t.slice(last, m.index)); last = m.index + m[0].length;
        const tex = (m[1] ?? m[2]).trim(); const display = m[2] != null;
        try {
            if (!mj) throw new Error('no engine');
            const node = await mj.tex2svgPromise(tex, { display: false }); const svg = node.querySelector('svg');
            svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); svg.style.color = '#1b1f3b';
            const vAlign = svg.style.verticalAlign || '0'; const ser = new XMLSerializer().serializeToString(svg).replace(/currentColor/g, '#1b1f3b');
            const w = svg.getAttribute('width'), h = svg.getAttribute('height');
            out += `<img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(ser)}" style="width:${w};height:${h};vertical-align:${vAlign};${display ? 'margin:0 2px;' : ''}">`;
        } catch { out += _escH(tex); }
    }
    return out + _escH(t.slice(last));
}

export type ReportPage = { w: number; h: number; landscape: boolean; inner: string };
export type ReportBuild = { specs: ReportPage[]; ff: string; PAD: number; when: string; nm: string; test: string };

export async function buildOsmPages(report: any, ctx: any, say: (t: string) => void = () => { /* */ }): Promise<ReportBuild> {
    const made: HTMLElement[] = [];
    try {
        const of: any = report.overallFeedback || {}; const an: any = report.analysis || {};
        const dt = Number(report.maximumMarks) || 0; const score = Number(report.overallScore) || 0; const pct = dt ? Math.round(score / dt * 100) : 0;
        const all: any[] = report.questionWiseReport || []; const qs = all.filter(q => !q._runtimeOrLoser);
        const nm = String(report.studentName || '').trim(); const fw = nm.split(' ')[0]; const first = fw ? fw.charAt(0).toUpperCase() + fw.slice(1).toLowerCase() : 'there';
        const f1 = (n: number) => String(Math.round(n * 100) / 100);
        const plain = (t: any) => String(t ?? '').replace(/\\\(|\\\)|\\\[|\\\]/g, '').replace(/\\text\{([^}]*)\}/g, '$1').replace(/\\d?frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)').replace(/\\times/g, '×').replace(/\\cdot/g, '·').replace(/\\rightarrow/g, '→').replace(/\\Rightarrow/g, '⇒').replace(/\\circ/g, '°').replace(/\\(?:left|right)/g, '').replace(/[{}]/g, '').replace(/\\([a-zA-Z]+)/g, '$1').replace(/\s+/g, ' ').trim();
        const clip = (t: string, n: number) => t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t;
        const green = '#1e8e4e', amber = '#d17a0a', red = '#d12f3a';
        const colOf = (g: number, m: number) => g >= m ? green : g <= 0 ? red : amber;
        const bgOf = (g: number, m: number) => g >= m ? '#e8f6ee' : g <= 0 ? '#fdeaec' : '#fff3e0';
        const grade = pct >= 90 ? 'A+' : pct >= 80 ? 'A' : pct >= 70 ? 'B+' : pct >= 60 ? 'B' : pct >= 50 ? 'C' : 'D';
        const gcol = pct >= 80 ? green : pct >= 50 ? amber : red;
        const msg = pct >= 80 ? [`Excellent work, ${first}.`, 'Keep it up. A few points to polish are below.'] : pct >= 60 ? [`Good effort, ${first}.`, 'You have a solid base. Let us strengthen the areas below.'] : [`Nice try, ${first}.`, 'You have a base to build on. Let us strengthen the areas below.'];
        const LRN = computeLearn(all); const LNM = learnNames(LRN);
        const nFull = qs.filter(q => q.marksAwarded >= q.maxMarksForQuestion).length, nZero = qs.filter(q => !(q.marksAwarded > 0)).length, nPart = qs.length - nFull - nZero;
        const ff = 'font-family:Poppins,Arial,sans-serif;color:#1b1f3b;box-sizing:border-box;';
        const school = String(ctx.schoolName || report.schoolName || '').trim();
        const when = new Date(report.gradingTimestamp || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        const sub = ctx.subject || report.subject || '', cls = `Class ${ctx.className || report.className || ''}-${ctx.section || report.section || ''}`, test = ctx.assessmentTitle || '';
        const PW = 794, PH = 1123, LW = 1123, LH = 794, PAD = 28, FOOT = 34;
        // ── measuring + packing: every card is measured; a card that does not fit moves WHOLE to the next page ──
        const host = document.createElement('div'); host.style.cssText = `position:fixed;left:-30000px;top:0;visibility:hidden;${ff}`; document.body.appendChild(host); made.push(host);
        const hOf = (html: string, w: number) => { const d = document.createElement('div'); d.style.cssText = `width:${w}px;display:flow-root;`; d.innerHTML = html; host.appendChild(d); const h = d.getBoundingClientRect().height; host.removeChild(d); return Math.ceil(h); };
        const pack = (blocks: string[], w: number, avail: number, firstAvail?: number): string[][] => { const pages: string[][] = [[]]; let used = 0, cap = firstAvail ?? avail; for (const b of blocks) { const h = hOf(b, w); if (used + h > cap && pages[pages.length - 1].length) { pages.push([]); used = 0; cap = avail; } pages[pages.length - 1].push(b); used += h; } return pages; };
        const chip = (t: string, col: string) => `<span style="display:inline-block;margin:2px 5px 2px 0;padding:4px 10px;border-radius:99px;background:#fff;border:1px solid ${col};font-size:10px;font-weight:600;">${_escH(t.replace(/^\[([^\]]+)\].*$/, '$1'))}</span>`;
        const chipList = (arr: any[], max: number, col: string) => { const a = (Array.isArray(arr) ? arr : []).map(x => String(typeof x === 'string' ? x : x?.text || '')); return a.slice(0, max).map(t => chip(t, col)).join('') + (a.length > max ? chip(`+${a.length - max} more (see the learning summary)`, col) : '') || '<span style="color:#7f8c8d;font-size:10px;">—</span>'; };
        const specs: { w: number; h: number; inner: string; landscape: boolean }[] = [];
        // ── 1) score page (portrait) ──
        const C = 2 * Math.PI * 46;
        const p1Head = `<div style="background:linear-gradient(160deg,#1a1f6e,#3b2d9c);padding:26px 30px 52px;color:#fff;">
            <div style="display:flex;justify-content:space-between;"><div style="font-size:9px;letter-spacing:2px;opacity:.85;">ASSESSMENT REPORT</div><div style="font-size:8px;opacity:.8;text-align:right;">POWERED BY<br><b style="font-size:12px;">ClassMap AI</b></div></div>
            <div style="font-size:26px;font-weight:700;margin:3px 0 12px;">${_escH(school)}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;">${[['SUBJECT', sub], ['CLASS', cls], ['TEST', test], ['DATE', when]].map(([a, b]) => `<div style="border:1px solid rgba(255,255,255,.35);border-radius:10px;padding:6px 10px;background:rgba(255,255,255,.08);"><div style="font-size:7px;letter-spacing:1.3px;opacity:.8;">${a}</div><div style="font-size:11px;font-weight:600;">${_escH(b)}</div></div>`).join('')}</div>
            <div style="margin-top:12px;border-left:3px solid #a9b4ff;padding-left:10px;"><div style="font-size:7px;letter-spacing:1.3px;opacity:.8;">STUDENT</div><div style="font-size:21px;font-weight:700;">${_escH(nm.toUpperCase())}</div><div style="font-size:10px;opacity:.85;">Roll ${_escH(report.rollNumber || '')}</div></div></div>`;
        const scoreCard = `<div style="margin:-36px 0 12px;background:#fff;border-radius:20px;box-shadow:0 4px 18px rgba(30,30,90,.16);padding:16px 22px;display:flex;align-items:center;gap:20px;">
            <div style="position:relative;width:100px;height:100px;flex:none;"><svg width="100" height="100" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="none" stroke="#e8ebf5" stroke-width="10"/><circle cx="50" cy="50" r="40" fill="none" stroke="${gcol}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(2 * Math.PI * 40 * Math.min(100, pct) / 100).toFixed(1)} ${(2 * Math.PI * 40).toFixed(1)}" transform="rotate(-90 50 50)"/></svg><div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;"><div style="font-size:21px;font-weight:700;">${pct}%</div><div style="font-size:7px;color:#7f8c8d;letter-spacing:1px;">SCORE</div></div></div>
            <div style="border-right:1px solid #e3e6f3;padding-right:20px;"><div style="font-size:8px;color:#7f8c8d;letter-spacing:1px;">MARKS</div><div style="font-size:34px;font-weight:700;line-height:1.1;">${f1(score)}<span style="font-size:13px;color:#7f8c8d;font-weight:500;"> / ${f1(dt)}</span></div><div style="display:inline-block;margin-top:5px;background:${gcol};color:#fff;border-radius:99px;padding:5px 16px;font-weight:700;font-size:11px;">Grade ${grade}</div></div>
            <div style="flex:1;"><div style="font-size:16px;font-weight:700;">${_escH(msg[0])}</div><div style="font-size:10px;color:#6b7280;margin-top:3px;">${_escH(msg[1])}</div>
              <div style="margin-top:9px;font-size:9.5px;font-weight:600;"><span style="background:#e8f6ee;color:${green};padding:4px 9px;border-radius:99px;margin-right:4px;">● ${nFull} full marks</span><span style="background:#fff3e0;color:${amber};padding:4px 9px;border-radius:99px;margin-right:4px;">● ${nPart} partial</span><span style="background:#fdeaec;color:${red};padding:4px 9px;border-radius:99px;">● ${nZero} to work on</span></div></div></div>`;
        const twoBoxes = (max: number) => `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
            <div style="border:1.5px solid ${green};background:#eaf7ef;border-radius:14px;padding:10px 13px;"><div style="font-size:8px;letter-spacing:1.4px;font-weight:700;color:${green};margin-bottom:5px;">WHAT YOU DID WELL</div>${chipList(LNM.strengths, max, green)}</div>
            <div style="border:1.5px solid ${amber};background:#fff4e2;border-radius:14px;padding:10px 13px;"><div style="font-size:8px;letter-spacing:1.4px;font-weight:700;color:${amber};margin-bottom:5px;">WHERE TO IMPROVE</div>${chipList(LNM.improve, max, amber)}</div></div>`;
        const cell = (q: any) => { const g = Number(q.marksAwarded) || 0, m = Number(q.maxMarksForQuestion) || 0; return `<div style="border:1.5px solid ${colOf(g, m)};background:${bgOf(g, m)};border-radius:9px;padding:4px 8px;"><div style="display:flex;justify-content:space-between;font-weight:700;font-size:10px;"><span><span style="color:${colOf(g, m)}">●</span> Q${_escH(q.questionNumber)}</span><span style="color:${colOf(g, m)}">${f1(g)}/${f1(m)}</span></div><div style="height:3px;background:rgba(255,255,255,.85);border-radius:3px;margin-top:3px;overflow:hidden;"><i style="display:block;height:100%;width:${m ? Math.min(100, g / m * 100) : 0}%;background:${colOf(g, m)};"></i></div></div>`; };
        const rows: string[] = []; for (let k = 0; k < qs.length; k += 5) rows.push(`<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:7px;margin-bottom:7px;">${qs.slice(k, k + 5).map(cell).join('')}</div>`);
        const bdHead = `<div style="display:flex;justify-content:space-between;align-items:center;margin:4px 0 7px;"><div style="font-size:9px;letter-spacing:1.4px;font-weight:700;color:#1a1f6e;">MARKS BREAKDOWN</div><div style="font-size:8.5px;color:#6b7280;"><span style="color:${green}">●</span> Full marks &nbsp;<span style="color:${amber}">●</span> Partial &nbsp;<span style="color:${red}">●</span> No marks</div></div>`;
        const totalBar = `<div style="margin-top:6px;background:#1a1f6e;color:#fff;border-radius:14px;padding:12px 20px;display:flex;justify-content:space-between;align-items:center;"><div style="font-weight:700;letter-spacing:1px;font-size:10px;">TOTAL SCORE</div><div><span style="font-size:22px;font-weight:700;">${f1(score)}</span><span style="opacity:.7;font-size:12px;"> / ${f1(dt)}</span> <b style="margin-left:10px;font-size:13px;">${pct}%</b></div></div>`;
        const contBar = (label: string) => `<div style="background:#37474f;color:#fff;border-radius:10px;padding:8px 16px;display:flex;justify-content:space-between;font-size:10px;margin-bottom:12px;"><b>${label}</b><span style="opacity:.85;">${_escH(nm.toUpperCase())} &nbsp;${_escH(report.rollNumber || '')}</span></div>`;
        { const bodyW = PW - 2 * PAD; const headH = hOf(p1Head, PW);
          const first1 = [scoreCard, twoBoxes(12), bdHead + (rows[0] || ''), ...rows.slice(1), totalBar];
          const pk = pack(first1, bodyW, PH - PAD - FOOT - 40, PH - headH - FOOT - 16);
          pk.forEach((blocks, n) => specs.push({ w: PW, h: PH, landscape: false, inner: n === 0 ? `${p1Head}<div style="padding:0 ${PAD}px;">${blocks.join('')}</div>` : `<div style="padding:${PAD}px;">${contBar('ASSESSMENT REPORT (continued)')}${blocks.join('')}</div>` })); }
        // ── 2) answer-sheet pages (landscape): sheet on the left, question cards on the right ──
        say('Loading the answer sheets…');
        const urls: string[] = report.answerSheetImageUrls || [];
        const pageOf = (q: any) => (Number.isInteger(q.answerPageIndex) && q.answerPageIndex >= 0) ? q.answerPageIndex : (q.answerPageIndices?.length ? q.answerPageIndices[0] : 0);
        const byPage = new Map<number, any[]>(); qs.forEach(q => { const k = pageOf(q); if (!byPage.has(k)) byPage.set(k, []); byPage.get(k)!.push(q); });
        const picOf = new Map<number, string>(); const need = [...byPage.keys()].sort((a, b) => a - b);
        const loadPic = async (pg: number) => {
            const u = urls[pg]; if (!u) return;
            try {
                const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
                const blob = await (await fetch(u, { mode: 'cors', signal: ctl.signal })).blob(); clearTimeout(to);
                const bmp = await createImageBitmap(blob); const w = Math.min(1800, bmp.width); const h = Math.round(bmp.height * w / bmp.width);   // keep the handwriting sharp
                const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
                // the teachers' own pen marks, notes, ticks and crosses, drawn exactly where they were placed (ink coordinates are 0-1000 wide)
                try {
                    const k = w / 1000; g.save(); g.scale(k, k); g.lineCap = 'round'; g.lineJoin = 'round';
                    Object.values((ctx && ctx.ink) || {}).forEach((pgs: any) => ((pgs || {})[String(pg)] || []).forEach((st: any) => {
                        if (st.k) { const x = +st.x || 0, y = +st.y || 0, z = +st.w || 40; const P = new Path2D(st.k === 'tick' ? `M${x - .45 * z} ${y + .02 * z} L${x - .12 * z} ${y + .38 * z} L${x + .5 * z} ${y - .4 * z}` : `M${x - .4 * z} ${y - .4 * z} L${x + .4 * z} ${y + .4 * z} M${x + .4 * z} ${y - .4 * z} L${x - .4 * z} ${y + .4 * z}`); g.strokeStyle = st.k === 'tick' ? '#1e8e4e' : '#d93025'; g.lineWidth = z * .15; g.stroke(P); }
                        else if (st.t !== undefined) { const fs = +st.w || 24; g.font = `600 ${fs}px Poppins, Arial, sans-serif`; g.fillStyle = st.c || '#d93025'; g.strokeStyle = '#fff'; g.lineWidth = Math.max(3, fs / 6); String(st.t).split('\n').forEach((ln: string, li: number) => { g.strokeText(ln, +st.x || 0, (+st.y || 0) + li * fs * 1.2); g.fillText(ln, +st.x || 0, (+st.y || 0) + li * fs * 1.2); }); }
                        else if (st.d) { g.strokeStyle = st.c || '#d93025'; g.lineWidth = +st.w || 3; g.stroke(new Path2D(st.d)); }
                    })); g.restore();
                } catch (e) { console.warn('[osm pdf] annotations not drawn', e); }
                picOf.set(pg, cv.toDataURL('image/jpeg', 0.93));
            } catch (e) { console.warn('[osm pdf] sheet picture not available for page', pg + 1, e); }
        };
        for (let k = 0; k < need.length; k += 4) { say(`Loading answer sheet ${Math.min(k + 4, need.length)} of ${need.length}…`); await Promise.all(need.slice(k, k + 4).map(loadPic)); }
        say('Typesetting formulas…');
        const solHtml = new Map<any, string>(); for (const q of qs) { if (q.marksAwarded >= q.maxMarksForQuestion) continue; solHtml.set(q, await osmMathToHtml(q.answer, { maxChars: 700 })); }
        const box = (label: string, text: string, bg: string, lc: string, raw?: string) => (raw || text) ? `<div style="background:${bg};border-radius:8px;padding:6px 9px;margin-top:6px;"><div style="font-size:7px;letter-spacing:1.1px;font-weight:700;color:${lc};">${label}</div><div style="font-size:10px;line-height:1.5;white-space:pre-wrap;">${raw ?? _escH(text)}</div></div>` : '';
        const card = (q: any) => {
            const g = Number(q.marksAwarded) || 0, m = Number(q.maxMarksForQuestion) || 0; const full = g >= m;
            const head = `<div style="display:flex;justify-content:space-between;align-items:center;"><b style="font-size:13px;color:#1a1f6e;">Q${_escH(q.questionNumber)}</b>${full && !q.teacherNote ? `<span style="font-size:9.5px;color:${green};font-weight:600;margin-left:8px;flex:1;">✓ Full marks</span>` : ''}<span style="background:${bgOf(g, m)};color:${colOf(g, m)};font-weight:700;font-size:10.5px;padding:3px 10px;border-radius:99px;">${f1(g)}/${f1(m)}</span></div>`;
            const note = q.teacherNote ? box("TEACHER'S NOTE", q.teacherNote, '#fff6df', '#a8700a') : '';
            if (full) return `<div style="border:1px solid #e3e6f3;border-radius:10px;padding:5px 10px;margin-bottom:6px;background:#fff;">${head}${note}</div>`;
            const why = q.whyLost || '', how = q.howToImprove || ''; const legacy = !why && !how ? String(q.finalFeedback || '') : '';
            return `<div style="border:1px solid #e3e6f3;border-radius:10px;padding:8px 10px;margin-bottom:7px;background:#fff;">${head}${note}
              ${box('SOLUTION', String(q.answer || ''), '#efeafc', '#5b3fa0', solHtml.get(q))}
              ${(why || how) ? `<div style="background:#e8f0ff;border-radius:8px;padding:6px 9px;margin-top:6px;">${why ? `<div style="font-size:7px;letter-spacing:1.1px;font-weight:700;color:#2a4fb0;">WHERE YOU LOST MARKS</div><div style="font-size:10px;line-height:1.4;margin-bottom:${how ? 4 : 0}px;">${_escH(why)}</div>` : ''}${how ? `<div style="font-size:7px;letter-spacing:1.1px;font-weight:700;color:#2a4fb0;">HOW TO IMPROVE</div><div style="font-size:10px;line-height:1.4;">${_escH(how)}</div>` : ''}</div>` : box('FEEDBACK', legacy, '#e8f0ff', '#2a4fb0')}</div>`;
        };
        const IMGW = 430, GAP = 16, sheetHead = (pg: number, cont: boolean) => `<div style="background:#37474f;color:#fff;border-radius:10px;padding:8px 16px;display:flex;justify-content:space-between;font-size:10.5px;"><b>ANSWER SHEET — PAGE ${pg + 1}${cont ? ' (continued)' : ''}</b><span style="opacity:.85;">${_escH(nm.toUpperCase())} &nbsp;${_escH(report.rollNumber || '')}</span></div>`;
        for (const pg of need) {
            const has = picOf.has(pg); const rightW = has ? LW - 2 * PAD - IMGW - GAP : LW - 2 * PAD;
            const avail = LH - PAD - 36 - 12 - FOOT;
            const pk = pack(byPage.get(pg)!.map(card), rightW, avail);
            pk.forEach((blocks, n) => specs.push({ w: LW, h: LH, landscape: true, inner: `<div style="padding:${PAD - 8}px ${PAD}px 0;background:#f5f6fb;height:${LH}px;">${sheetHead(pg, n > 0)}
                <div style="display:grid;grid-template-columns:${has ? IMGW + 'px 1fr' : '1fr'};gap:${GAP}px;margin-top:12px;align-items:start;">
                  ${has ? `<div style="background:#fff;border:1px solid #e3e6f3;border-radius:10px;padding:5px;"><img src="${picOf.get(pg)}" style="width:100%;display:block;border-radius:6px;"></div>` : ''}
                  <div>${blocks.join('')}</div></div></div>` }));
        }
        // ── 3) learning summary (portrait) ──
        const bar = (label: string, val: string, p: number, col: string) => `<div style="display:flex;align-items:center;gap:10px;margin:5px 0;font-size:10.5px;"><div style="width:42%;font-weight:600;">${_escH(label)}</div><div style="flex:1;height:8px;background:#eef0f7;border-radius:6px;overflow:hidden;"><i style="display:block;height:100%;width:${Math.max(0, Math.min(100, p))}%;background:${col};border-radius:6px;"></i></div><div style="width:60px;text-align:right;font-weight:700;color:${col};">${_escH(val)}</div></div>`;
        const sect = (t: string, sub2: string) => `<div style="margin-top:12px;font-size:10px;letter-spacing:1px;font-weight:700;color:#1a1f6e;">${t} <span style="font-weight:400;color:#7f8c8d;letter-spacing:0;">${sub2}</span></div>`;
        const cm: any[] = an.conceptMastery || of.conceptMastery || []; const lb: any[] = an.lostByMode || []; const tp: any[] = (report.studentIntelligence?.questionTypePerformance) || [];
        const steps: any[] = Array.isArray(of.nextSteps) ? of.nextSteps : [];
        const sb: string[] = learnBlocks(LRN, { fs: 10.5, steps }).map(x => x.html);
        if (tp.length) { const tt = (t: any) => bar(String(t.type || '').charAt(0) + String(t.type || '').slice(1).toLowerCase(), `${f1(t.scored)}/${f1(t.max)}`, t.max ? t.scored / t.max * 100 : 0, t.max && t.scored / t.max >= .8 ? green : amber); sb.push(sect('SCORE BY QUESTION TYPE', '') + tt(tp[0])); tp.slice(1).forEach(t => sb.push(tt(t))); }
        { const pk = pack(sb, PW - 2 * PAD, PH - PAD - FOOT - 44);
          pk.forEach((blocks, n) => specs.push({ w: PW, h: PH, landscape: false, inner: `<div style="padding:${PAD}px;">${contBar(n === 0 ? 'YOUR LEARNING SUMMARY' : 'YOUR LEARNING SUMMARY (continued)')}${blocks.join('')}</div>` })); }
        return { specs, ff, PAD, when, nm, test };
    } finally { made.forEach(d => d.remove()); }
}
export const osmPageFooter = (PAD: number, when: string, n: number) => `<div style="position:absolute;left:${PAD}px;right:${PAD}px;bottom:10px;display:flex;justify-content:space-between;font-size:8px;color:#95a5a6;"><span>Confidential — for student and parent use only</span><span>ClassMap AI · ${_escH(when)} · ${n + 1}</span></div>`;

const _loadScript = (src: string): Promise<void> => new Promise((resolve, reject) => { if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; } const sc = document.createElement('script'); sc.src = src; sc.onload = () => resolve(); sc.onerror = () => reject(); document.head.appendChild(sc); });

export async function osmReportPdf(report: any, ctx: any, say: (t: string) => void = () => { /* */ }) {
    await _loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
    await _loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    const html2canvas = (window as any).html2canvas; const { jsPDF } = (window as any).jspdf;
    const { specs, ff, PAD, when, nm, test } = await buildOsmPages(report, ctx, say);
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    for (let n = 0; n < specs.length; n++) {
        say(`Preparing page ${n + 1} of ${specs.length}…`); await new Promise(r => setTimeout(r, 15));
        const sp = specs[n];
        const el = document.createElement('div'); el.style.cssText = `position:fixed;left:-30000px;top:0;width:${sp.w}px;height:${sp.h}px;background:#fff;overflow:hidden;${ff}`;
        el.innerHTML = `${sp.inner}${osmPageFooter(PAD, when, n)}`;
        document.body.appendChild(el);
        try {
            await Promise.all(Array.from(el.querySelectorAll('img')).map(img => (img as HTMLImageElement).decode ? (img as HTMLImageElement).decode().catch(() => { /* */ }) : Promise.resolve()));
            const canvas = await html2canvas(el, { scale: 3, backgroundColor: '#ffffff', logging: false, width: sp.w, height: sp.h, windowWidth: sp.w, windowHeight: sp.h });   // print quality: ~290 dpi
            if (n > 0) pdf.addPage('a4', sp.landscape ? 'l' : 'p'); else if (sp.landscape) { pdf.deletePage(1); pdf.addPage('a4', 'l'); }
            pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, pdf.internal.pageSize.getWidth(), pdf.internal.pageSize.getHeight(), undefined, 'SLOW');
        } finally { el.remove(); }
    }
    say('Saving the PDF…');
    pdf.save(`${(nm || 'student').replace(/[^\w]+/g, '_')}_${(test || 'exam').replace(/[^\w]+/g, '_')}_report.pdf`);
}

// The same pages, shown on screen (scaled to the screen width). Used by the student app.
export async function mountOsmReportView(container: HTMLElement, report: any, ctx: any, say: (t: string) => void = () => { /* */ }) {
    container.innerHTML = '<div style="padding:40px;text-align:center;color:#6b7280;font-family:Poppins,Arial,sans-serif;">Loading your report…</div>';
    const { specs, ff, PAD, when } = await buildOsmPages(report, ctx, say);
    container.innerHTML = '';
    const col = document.createElement('div'); col.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:14px;padding:12px;background:#eef0f7;'; container.appendChild(col);
    const pages: { outer: HTMLElement; inner: HTMLElement; sp: ReportPage }[] = [];
    specs.forEach((sp, n) => {
        const outer = document.createElement('div'); outer.style.cssText = 'position:relative;background:#fff;box-shadow:0 2px 14px rgba(30,30,90,.18);border-radius:6px;overflow:hidden;flex:none;';
        const inner = document.createElement('div'); inner.style.cssText = `position:absolute;left:0;top:0;width:${sp.w}px;height:${sp.h}px;transform-origin:0 0;overflow:hidden;${ff}`;
        inner.innerHTML = `${sp.inner}${osmPageFooter(PAD, when, n)}`; outer.appendChild(inner); col.appendChild(outer); pages.push({ outer, inner, sp });
    });
    const fit = () => { const avail = Math.max(280, (container.clientWidth || window.innerWidth) - 24); pages.forEach(({ outer, inner, sp }) => { const k = Math.max(0.4, Math.min(1, avail / sp.w)); inner.style.transform = `scale(${k})`; outer.style.width = sp.w * k + 'px'; outer.style.height = sp.h * k + 'px'; }); };
    fit(); const ro = () => fit(); window.addEventListener('resize', ro);
    (container as any)._osmUnmount = () => window.removeEventListener('resize', ro);
}
