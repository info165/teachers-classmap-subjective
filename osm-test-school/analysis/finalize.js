// Usage: node finalize.js <workdir> [--write] [--complete]
// Reads <workdir>/manifest.json (from export.js) and <workdir>/feedback/<roll>.json (written by Claude), validates, and with --write
// creates the standard submission documents so the EXISTING teacher report screen + teacher/admin publish work unchanged.
// RULES (see README): teacher marks are fixed truth; full marks => NO feedback; every lost mark must be explained from the
// answer key / rubric with quoted evidence that is machine-checked against the key; concept mastery is computed from marks, never guessed.
const {admin,db}=require('./common'); const fs=require('fs'),path=require('path');
const { computeOrLoserQNums } = require('./orRule');
const ONLY=(process.argv.includes('--only')?String(process.argv[process.argv.indexOf('--only')+1]).split(','):null);
const dir=process.argv[2]; const WRITE=process.argv.includes('--write'); const COMPLETE=process.argv.includes('--complete');
if(!dir){console.log('usage: node finalize.js <workdir> [--write] [--complete]');process.exit(1);}
const man=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')); const P=man.paper; if(ONLY) man.students=man.students.filter(s=>ONLY.includes(String(s.roll)));
const FM=['NEVER_KNEW','KNEW_BUT_FORGOT','KNEW_BUT_MISAPPLIED','KNEW_BUT_MISCALCULATED','KNEW_BUT_INCOMPLETE'];
const TYPES=['RECALL','CONCEPTUAL','NUMERICAL','DERIVATION','DIAGRAM','APPLICATION','REASONING'];
const BAD_PARTIAL=/\b(completely (wrong|incorrect)|totally (wrong|incorrect)|no marks|zero marks|entirely wrong|not attempted)\b/i;
const GOOD_ZERO=/\b(partially correct|partly correct|mostly correct|well done|good attempt|fully correct|full marks|correct answer|excellent)\b/i;
const STOP=new Set('the and for are was were with that this from not but have has had you your what when which will would can could should into than then them they their its it is of in on to as at by an or be a if so we our also more most any all each other such'.split(' '));
const norm=s=>String(s||'').toLowerCase().replace(/\\\(|\\\)|\\text|\\dfrac|\\frac|\\times|\\rightarrow|[{}$]/g,' ').replace(/[^a-z0-9.%+\-=\/ ]+/g,' ').replace(/\s+/g,' ').trim();
const toks=s=>norm(s).split(' ').filter(t=>t.length>=3&&!STOP.has(t));
function grounded(item,src){ const ni=norm(item); if(!ni) return false; const ns=norm(src); if(ns.includes(ni)) return true;
  const t=toks(item); if(t.length<2) return ns.includes(ni); const set=new Set(toks(src)); return t.filter(x=>set.has(x)).length/t.length>=0.75; }
const sources=q=>[q.answer,JSON.stringify(q.rubric||{}),q.checkingInstructions,(q.options||[]).join(' '),(q.markingSteps||[]).map(s=>s.description).join(' ')].filter(Boolean).join(' \n ');
const fmtN=n=>String(Math.round(n*100)/100);
const cleanAns=(t)=>String(t||'').replace(/\\\(|\\\)|\$|\\text\{|[{}]/g,'').replace(/\s+/g,' ').trim();
// can `lost` be formed from a subset of the rubric's step marks?  (soft QA only)
function subsetSum(arr,target){ let s=new Set([0]); arr.forEach(a=>{const n=new Set(s); s.forEach(x=>n.add(Math.round((x+a)*100)/100)); s=n;}); return s.has(Math.round(target*100)/100); }
const level=p=>p>=85?'Strong':p>=70?'Good':p>=50?'Developing':'Needs work';
(async()=>{
 const problems=[], warnings=[], plan=[];
 // PAPER CHECK: every "Alternative Question (OR) with Question X" must be reciprocated by X, otherwise the pair is not recognised and
 // the unattempted side is wrongly counted as lost marks (and shows up as a weakness).
 { const byNo=Object.fromEntries(man.questions.map(q=>[String(q.questionNumber).toLowerCase().replace(/[^a-z0-9]/g,''),q]));
   man.questions.forEach(q=>{ const ci=q.checkingInstructions||''; if(!/alternative question \(or\)/i.test(ci))return; const mm=ci.match(/with\s+question\s+([\w.\-\s()]+?)(?:\.\s|\.$|,|;|$)/i); if(!mm)return;
     const pk=mm[1].trim().toLowerCase().replace(/[^a-z0-9]/g,''); const p=byNo[pk]; const qn=q.questionNumber;
     if(!p){problems.push(`PAPER: Q${qn} says it is an alternative of Q${mm[1].trim()} but that question does not exist`);return;}
     const back=(p.checkingInstructions||'').match(/with\s+question\s+([\w.\-\s()]+?)(?:\.\s|\.$|,|;|$)/i);
     if(!/alternative question \(or\)/i.test(p.checkingInstructions||'')||!back||back[1].trim().toLowerCase().replace(/[^a-z0-9]/g,'')!==String(qn).toLowerCase().replace(/[^a-z0-9]/g,'')) problems.push(`PAPER: Q${qn} is marked "alternative (OR) with Q${mm[1].trim()}" but Q${p.questionNumber} does not carry the matching OR marker, so the pair is not recognised. Fix the question paper's checking instructions.`); }); }
 for(const s of man.students){
  const R=s.roll; const ff=path.join(dir,'feedback',`${R}.json`); if(!fs.existsSync(ff)){problems.push(`${R} ${s.name}: no feedback file`);continue;}
  let fb; try{fb=JSON.parse(fs.readFileSync(ff,'utf8'));}catch(e){problems.push(`${R}: feedback JSON invalid (${e.message})`);continue;}
  const byIdx=new Map((fb.questions||[]).map(q=>[q.i,q])); const nPages=(s.pages||[]).length;
  const reports=[]; let bad=false; const flags=[];
  const losersPre=new Set(s.losers||[]);
  man.questions.forEach((q,i)=>{
   const qn=q.questionNumber||String(i+1); const m=s.marks[qn]; const f=byIdx.get(i)||{}; const max=Number(q.marks)||0; const got=m.marks;
   const isAlt=/alternative question \(or\)/i.test(q.checkingInstructions||''); const notChosen=!!(f.altNotChosen&&isAlt);
   const loser=losersPre.has(qn)||notChosen; const counted=!loser; const lost=counted&&got<max;
   const tag=`${R} Q${qn} (${fmtN(got)}/${fmtN(max)})`;
   if(!f.topic) {problems.push(`${tag}: topic missing`); bad=true;}
   if(!f.concept) {problems.push(`${tag}: concept (chapter-level group, e.g. "Atomic structure") missing`); bad=true;}
   if(f.questionType&&!TYPES.includes(f.questionType)) warnings.push(`${tag}: unknown questionType ${f.questionType}, using CONCEPTUAL`);
   if(counted&&!f.unattempted&&!(Number.isInteger(f.page)&&f.page>=1&&f.page<=nPages)) {problems.push(`${tag}: page (1-${nPages}) where the answer is written is required`); bad=true;}
   let finalFeedback='', failureMode='', steps=[], whyOut='', howOut='';
   const tnote=counted?String(((s.teacherNotes||{})[qn]||{}).text||'').trim():'';
   if(f.teacherFlag){ flags.push({q:qn,text:f.teacherFlag}); warnings.push(`${tag}: FOR THE TEACHER - ${f.teacherFlag}`); }
   const isMCQ=/mcq|assertion|true/i.test(q.type||'');
   // student-language guard: feedback the student reads must NEVER mention the key / rubric / marking scheme
   const FORBID=/\b(rubric|answer key|mark scheme|marking scheme|the key\b|per the key|key'?s answer|key (?:says|gives|lists|expects|adds|names|has|wants|is)|the scheme\b)/i;
   const mkSteps=(txt)=>Number.isInteger(f.page)?[{pageIndex:f.page,stepPoint:[],marks:0,isMissing:!!f.unattempted,comment:txt}]:[];
   if(lost){
     const unatt=!!f.unattempted;
     if(isMCQ && !unatt){
       // mechanical, no AI call: state the correct answer in the student's own language
       const ca=cleanAns(q.answer);
       whyOut=ca?`The correct answer is ${ca}.`:'This answer was not correct.';
       finalFeedback=whyOut; steps=mkSteps(whyOut);
     } else {
       if(!f.whyWrong||!f.howToImprove){problems.push(`${tag}: marks lost, so whyWrong and howToImprove are required`);bad=true;}
       if(!FM.includes(f.failureMode)){problems.push(`${tag}: failureMode must be one of ${FM.join(', ')}`);bad=true;}
       whyOut=(f.whyWrong||'').trim(); howOut=(f.howToImprove||'').trim();
       const text=`${f.headline||''} ${whyOut} ${howOut}`;
       if(FORBID.test(text)){problems.push(`${tag}: student-facing feedback must NOT mention the key / rubric / marking scheme - say the correct fact directly, in the student's own words (not "the key says")`);bad=true;}
       if(got>0&&BAD_PARTIAL.test(text)){problems.push(`${tag}: partial marks were given but the feedback says it is wholly wrong`);bad=true;}
       if(got===0&&!unatt&&GOOD_ZERO.test(text)){problems.push(`${tag}: ZERO marks but the feedback sounds positive ("${text.slice(0,60)}")`);bad=true;}
       for(const mm of text.matchAll(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g)){ if(Math.abs(+mm[1]-got)>1e-9||Math.abs(+mm[2]-max)>1e-9){ problems.push(`${tag}: feedback quotes "${mm[0]}" which does not match the teacher's marks`);bad=true; } }
       const st=(q.markingSteps||[]).map(x=>Number(x.marks)).filter(x=>!isNaN(x));
       if(st.length&&Math.abs(st.reduce((a,b)=>a+b,0)-max)<1e-9&&!subsetSum(st,max-got)) warnings.push(`${tag}: lost ${fmtN(max-got)} but rubric steps are [${st.join(', ')}] - deduction does not match (teacher's mark kept; worth a look)`);
       failureMode=f.failureMode||'';
       finalFeedback=[tnote?`Teacher's note: ${tnote}`:'', unatt?'Not attempted.':(f.headline||'').trim(), whyOut?`What went wrong: ${whyOut}`:'', howOut?`How to improve: ${howOut}`:''].filter(Boolean).join('\n\n');
       steps=mkSteps(`${tnote?`Teacher's note: ${tnote} `:''}${whyOut} ${howOut}`.trim());
     }
   } else {
     if(counted&&tnote){ whyOut=`Teacher's note: ${tnote}`; finalFeedback=whyOut; if(Number.isInteger(f.page)) steps=[{pageIndex:f.page,stepPoint:[],marks:got,isMissing:false,comment:whyOut}]; }
     if(f.whyWrong||f.howToImprove||f.headline||f.feedback) warnings.push(`${tag}: ${loser?'uncounted alternative':'full marks'} - the feedback you wrote is ignored (none is shown)`);
     if(loser) finalFeedback='Not attempted';
   }
   const page=counted&&Number.isInteger(f.page)?f.page:null;
   reports.push({questionNumber:qn,text:q.text||'',answer:q.answer||'',type:q.type||'SA',marks:max,maxMarksForQuestion:max,marksAwarded:got,
     questionType:TYPES.includes(f.questionType)?f.questionType:'CONCEPTUAL',chapterTopic:f.topic||(q.topicAnchors&&q.topicAnchors[0])||P.title,topic:f.topic||'',concept:f.concept||'',topicAnchors:q.topicAnchors||[],
     checkingInstructions:q.checkingInstructions||'',rubric:q.rubric||{step_marking:'',keywords:[]},options:q.options||null,
     finalFeedback,failureMode,failurePoint:lost?(f.failurePoint||''):'',prerequisiteConcept:lost?(f.prerequisiteConcept||''):'',
     studentOcrAnswer:'',answerPageIndices:page?[page-1]:[],answerPageIndex:page?page-1:-1,requiresReview:false,stepWiseEvaluation:steps,
     whyLost:whyOut,howToImprove:howOut,teacherNote:tnote,headline:lost?(f.headline||'').trim():'',
     _runtimeOrLoser:loser,_unattemptedAlt:notChosen,_orPartnerQNum:null,markedBy:m.by,_source:'teacher_marking'});
  });
  if(bad||reports.length!==man.questions.length) continue;
  const losers=computeOrLoserQNums(reports,man.questions); reports.forEach(r=>r._runtimeOrLoser=losers.has(r.questionNumber)||r._unattemptedAlt);
  if(reports.some(r=>!r._unattemptedAlt&&r._runtimeOrLoser!==losersPre.has(r.questionNumber))) warnings.push(`${R}: OR losers recomputed differently from the export - check`);
  const counted=reports.filter(r=>!r._runtimeOrLoser);
  const total=counted.reduce((a,r)=>a+r.marksAwarded,0);
  // NOTE: the declared paper total is ALWAYS the total. Alternative (OR) questions both carry marks, so the sum of question marks is never compared with it.
  if(Math.abs(total-s.total)>1e-9) problems.push(`${R}: recomputed total ${total} != exported total ${s.total}`);
  // ---- concept mastery: computed from the teachers' marks only (uncounted alternatives excluded) ----
  const byTopic={}; counted.forEach(r=>{const t=r.topic; (byTopic[t]??={topic:t,scored:0,max:0,qs:[]}); byTopic[t].scored+=r.marksAwarded; byTopic[t].max+=r.maxMarksForQuestion; byTopic[t].qs.push(r.questionNumber);});
  const byConcept={}; counted.forEach(r=>{const c=r.concept; (byConcept[c]??={topic:c,scored:0,max:0,qs:[]}); byConcept[c].scored+=r.marksAwarded; byConcept[c].max+=r.maxMarksForQuestion; byConcept[c].qs.push(r.questionNumber);});
  const conceptMastery=Object.values(byConcept).map(t=>({topic:t.topic,scored:+fmtN(t.scored),max:+fmtN(t.max),pct:t.max?Math.round(t.scored/t.max*100):0,level:level(t.max?t.scored/t.max*100:0),questions:t.qs})).sort((a,b)=>a.pct-b.pct||b.max-a.max);
  const mastery=Object.values(byTopic).map(t=>({topic:t.topic,scored:+fmtN(t.scored),max:+fmtN(t.max),pct:t.max?Math.round(t.scored/t.max*100):0,level:level(t.max?t.scored/t.max*100:0),questions:t.qs})).sort((a,b)=>a.pct-b.pct||b.max-a.max);
  const strengthC=mastery.filter(c=>c.pct>=85).sort((a,b)=>b.max-a.max).slice(0,8).map(c=>c.topic);   // top concepts only
  const weakC=mastery.filter(c=>c.pct<70).sort((a,b)=>(b.max-b.scored)-(a.max-a.scored)).map(c=>c.topic);
  // next steps may only name weak concepts; the biggest weaknesses must each have one
  const steps=Array.isArray(fb.nextSteps)?fb.nextSteps:[];
  steps.forEach(x=>{ if(!x||!x.concept||!x.step) problems.push(`${R}: every nextSteps item needs {concept, step}`); else if(!weakC.includes(x.concept)) problems.push(`${R}: nextSteps names "${x.concept}" which is not a weak concept (weak: ${weakC.join('; ')||'none'})`); });
  weakC.slice(0,5).forEach(c=>{ if(!steps.some(x=>x&&x.concept===c)) problems.push(`${R}: no next step for weak concept "${c}"`); });
  const pctAll=P.declaredTotal?Math.round(total/P.declaredTotal*100):0;
  const strongCs=[...conceptMastery].filter(c=>c.pct>=70).sort((a,b)=>b.pct-a.pct).slice(0,2).map(c=>c.topic);
  const weakCs=[...conceptMastery].filter(c=>c.pct<60).sort((a,b)=>a.pct-b.pct).slice(0,2).map(c=>c.topic);
  const summaryText=`Scored ${fmtN(total)} out of ${fmtN(P.declaredTotal)} (${pctAll}%).`+(strongCs.length?` Strong on ${strongCs.join(' and ')}.`:'')+(weakCs.length?` The main areas to work on are ${weakCs.join(' and ')}.`:'');
  const areas=weakC.map(c=>{const ms=mastery.find(m=>m.topic===c); const why=reports.filter(r=>!r._runtimeOrLoser&&r.topic===c&&r.marksAwarded<r.maxMarksForQuestion).map(r=>`Q${r.questionNumber}`).join(', '); return `[${c}] ${fmtN(ms.scored)}/${fmtN(ms.max)} (${level(ms.pct)}) — marks lost in ${why}`;});
  const MODE={NEVER_KNEW:'Idea not known',KNEW_BUT_FORGOT:'Forgot a point',KNEW_BUT_MISAPPLIED:'Concept mixed up',KNEW_BUT_MISCALCULATED:'Calculation slip',KNEW_BUT_INCOMPLETE:'Answer incomplete'};
  const lostBy={}; counted.filter(r=>r.marksAwarded<r.maxMarksForQuestion&&r.failureMode).forEach(r=>{lostBy[r.failureMode]=(lostBy[r.failureMode]||0)+(r.maxMarksForQuestion-r.marksAwarded);});
  const lostByMode=Object.entries(lostBy).map(([k,v])=>({mode:k,label:MODE[k]||k,marks:+fmtN(v)})).sort((a,b)=>b.marks-a.marks);
  const analysis={marksToWinBack:+fmtN(Math.max(0,(P.declaredTotal||0)-total)),lostByMode,conceptMastery,topicMastery:mastery,strengths:strengthC,weaknesses:weakC,nextSteps:steps.map(x=>({concept:x.concept,step:x.step})),insight:summaryText,flags,generatedBy:'claude',generatedAt:new Date().toISOString(),edited:false};
  const byType={}; counted.forEach(r=>{const t=r.questionType; (byType[t]??={type:t,scored:0,max:0,count:0}); byType[t].scored+=r.marksAwarded; byType[t].max+=r.maxMarksForQuestion; byType[t].count++;});
  const qtp=Object.values(byType).map(t=>({...t,pct:t.max?Math.round(t.scored/t.max*100):0}));
  const pct=t=>qtp.find(x=>x.type===t)?.pct??0;
  const intel={questionTypePerformance:qtp,summary:{totalMarksLost:Math.max(0,(P.declaredTotal||0)-total),marksLostByType:qtp.map(t=>({type:t.type,marksLost:t.max-t.scored,pct:t.pct})),derivationPct:pct('DERIVATION'),recallPct:pct('RECALL'),numericalPct:pct('NUMERICAL')}};
  const pencil={}; s.pages.forEach((pg,pi)=>{const strokes=[]; Object.values(s.ink||{}).forEach(doc=>((doc.pages||{})[String(pi)]||[]).forEach(st=>{ if(!pg.w||!pg.h||!st.d)return; const H=1000*pg.h/pg.w; const off=(H-1000)/2; strokes.push(st.d.replace(/([ML])\s*([\d.]+)\s+([\d.]+)/g,(_m,c,x,y)=>`${c} ${x} ${(parseFloat(y)-off).toFixed(1)}`)); })); if(strokes.length)pencil[pi]=strokes;});
  const overall={summary:summaryText,strengths:strengthC,areasForImprovement:areas,nextSteps:analysis.nextSteps.map(x=>`${x.concept}: ${x.step}`),conceptMastery,topicMastery:mastery,analysisBy:'teacher_marking'};
  plan.push({s,reports,total,intel,pencil,overall,analysis});
 }
 console.log(`Students ready to finalize: ${plan.length}/${man.students.length}`);
 plan.forEach(p=>console.log(`  ${p.s.roll} weak concepts: ${p.analysis.weaknesses.join(' | ')||'none'}\n  ${p.s.roll} strong concepts: ${p.analysis.strengths.length}`));
 fs.writeFileSync(path.join(dir,'qa-report.txt'),`PROBLEMS (${problems.length})\n${problems.join('\n')}\n\nWARNINGS (${warnings.length})\n${warnings.join('\n')}\n`);
 if(warnings.length){console.log('\nWARNINGS ('+warnings.length+') - non-blocking, saved in qa-report.txt:');warnings.slice(0,12).forEach(w=>console.log(' ~ '+w));}
 if(problems.length){console.log('\nPROBLEMS ('+problems.length+'):');problems.forEach(p=>console.log(' - '+p)); if(WRITE){console.log('\nRefusing to write while problems exist. Fix feedback files and re-run.');process.exit(2);} }
 if(!WRITE){console.log('\nDry run only. Re-run with --write to save.');return;}
 const owner=db.collection('teachers').doc(P.owner).collection('assessmentHistory').doc(P.id);
 // Marks Given by the teachers IS their verification: every teacher on this class is recorded as verified so the normal
 // Publish (teacher or admin) is available straight away. Later edits never reset it.
 const rosters=await db.collection('classRosters').where('className','==',P.className).where('section','==',P.section).where('subject','==',P.subject).where('schoolName','==',P.schoolName).get();
 const expected=[]; rosters.docs.forEach(r=>{const x=r.data(); if((x.stream||'')!==(P.stream||''))return; if(!expected.some(e=>e.uid===x.teacherUid)) expected.push({uid:x.teacherUid,name:x.teacherName||''});});
 for(const {s,reports,total,intel,pencil,overall,analysis} of plan){
  const marked=new Set(reports.map(r=>r.markedBy));
  const ver={}; expected.forEach(t=>{ver[t.uid]={verified:true,teacherName:t.name,auto:true,via:'teacher_marking',gaveMarks:marked.has(t.uid)};});
  const sub=owner.collection('submissions').doc(s.studentUid);
  await sub.set({studentName:s.name,studentUid:s.studentUid,rollNumber:s.roll,maximumMarks:P.declaredTotal,overallScore:total,studentKeywords:[],studentIntelligence:intel,
    gradingTimestamp:new Date().toISOString(),assessmentId:P.id,subject:P.subject,className:P.className,section:P.section,requiresReview:false,
    answerSheetImageUrls:s.pages.map(p=>p.url),pencilAnnotations:pencil,overallFeedback:overall,analysis,
    teacherVerified:true,teacherVerifications:ver,published:false,source:'teacher_marking'});
  await sub.collection('detail').doc('report').set({questionWiseReport:reports,fullOcrText:''});
  console.log('  wrote',s.roll,s.name,`${total}/${P.declaredTotal}`,`concepts:${analysis.conceptMastery.length} topics:${analysis.topicMastery.length} strong:${analysis.strengths.length} weak:${analysis.weaknesses.length}`);
 }
 if(COMPLETE) console.log('\nNote: --complete is no longer used. The paper stays inside Teacher Marking (status: Analysis done), and is published from there.');
})().catch(e=>{console.error(e);process.exit(1)});
