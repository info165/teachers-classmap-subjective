// Usage: node finalize.js <workdir> [--write] [--complete]
// Reads <workdir>/manifest.json (from export.js) and <workdir>/feedback/<roll>.json (written by Claude),
// validates (teacher's marks are the fixed truth; feedback must not contradict them), and with --write
// creates the standard submission documents so the EXISTING teacher verification + admin/teacher publish work unchanged.
//   submissions/{uid}            main report doc   (teacherVerified:false, published:false)
//   submissions/{uid}/detail/report   questionWiseReport
// --complete additionally flips the paper from 'osm' (hidden) to 'osm_done' (visible as a normal exam) and
// creates the same exam entry for each co-teacher (exactly like today's per-teacher exam copies).
// NOTHING is written to studentAssessments here — students see nothing until the normal publish step.
const {admin,db}=require('./common'); const fs=require('fs'),path=require('path');
const { computeOrLoserQNums } = require('./orRule');
const dir=process.argv[2]; const WRITE=process.argv.includes('--write'); const COMPLETE=process.argv.includes('--complete');
if(!dir){console.log('usage: node finalize.js <workdir> [--write] [--complete]');process.exit(1);}
const man=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')); const P=man.paper;
const NEG=/\b(incorrect|wrong|not correct|did not|didn't|missing|incomplete|failed to|no marks|lost marks|error)\b/i;
const POS=/\b(fully correct|perfect|excellent|completely correct|full marks|well done|correct answer)\b/i;
const FM=['NEVER_KNEW','KNEW_BUT_FORGOT','KNEW_BUT_MISAPPLIED','KNEW_BUT_MISCALCULATED','KNEW_BUT_INCOMPLETE'];
const TYPES=['RECALL','CONCEPTUAL','NUMERICAL','DERIVATION','DIAGRAM','APPLICATION','REASONING'];
(async()=>{
 const problems=[]; const plan=[];
 for(const s of man.students){
  const ff=path.join(dir,'feedback',`${s.roll}.json`); if(!fs.existsSync(ff)){problems.push(`${s.roll} ${s.name}: no feedback file`);continue;}
  let fb; try{fb=JSON.parse(fs.readFileSync(ff,'utf8'));}catch(e){problems.push(`${s.roll}: feedback JSON invalid (${e.message})`);continue;}
  const byIdx=new Map((fb.questions||[]).map(q=>[q.i,q]));
  const reports=[]; 
  man.questions.forEach((q,i)=>{
   const qn=q.questionNumber||String(i+1); const m=s.marks[qn]; const f=byIdx.get(i);
   if(!f||!f.feedback){problems.push(`${s.roll} Q${qn}: missing feedback`);return;}
   const max=Number(q.marks)||0; const got=m.marks; const full=got>=max&&max>0, zero=got===0;
   const text=`${f.feedback} ${f.whyWrong||''}`;
   if(full&&NEG.test(f.feedback)&&!POS.test(f.feedback)) problems.push(`${s.roll} Q${qn}: FULL marks (${got}/${max}) but feedback sounds negative → "${f.feedback.slice(0,80)}"`);
   if(zero&&max>0&&POS.test(f.feedback)&&!NEG.test(text)) problems.push(`${s.roll} Q${qn}: ZERO marks but feedback sounds fully positive → "${f.feedback.slice(0,80)}"`);
   if(got<max&&!f.howToImprove&&!s.losers.includes(qn)) problems.push(`${s.roll} Q${qn}: marks lost (${got}/${max}) but no howToImprove`);
   if(got<max&&!s.losers.includes(qn)&&!FM.includes(f.failureMode||'')) problems.push(`${s.roll} Q${qn}: marks lost but failureMode is missing/invalid (use one of ${FM.join(', ')}) - the student app builds the study plan from it`);
   const parts=[f.feedback.trim()]; if(got<max&&f.whyWrong) parts.push(`Why marks were lost: ${f.whyWrong.trim()}`); if(got<max&&f.howToImprove) parts.push(`How to improve: ${f.howToImprove.trim()}`);
   reports.push({questionNumber:qn,text:q.text||'',answer:q.answer||'',type:q.type||'SA',marks:max,maxMarksForQuestion:max,marksAwarded:got,
     questionType:TYPES.includes(f.questionType)?f.questionType:'CONCEPTUAL',chapterTopic:f.topic||(q.topicAnchors&&q.topicAnchors[0])||P.title,topicAnchors:q.topicAnchors||[],
     checkingInstructions:q.checkingInstructions||'',rubric:q.rubric||{step_marking:'',keywords:[]},options:q.options||null,
     finalFeedback:parts.join('\n\n'),failureMode:got<max?(f.failureMode||''):'',failurePoint:got<max?(f.failurePoint||''):'',prerequisiteConcept:got<max?(f.prerequisiteConcept||''):'',studentOcrAnswer:'',answerPageIndices:[],requiresReview:false,stepWiseEvaluation:[],
     _runtimeOrLoser:s.losers.includes(qn),_orPartnerQNum:null,markedBy:s.marks[qn].by,_source:'teacher_marking'});
  });
  if(reports.length!==man.questions.length) continue;
  const losers=computeOrLoserQNums(reports,man.questions); reports.forEach(r=>r._runtimeOrLoser=losers.has(r.questionNumber));
  const total=reports.filter(r=>!r._runtimeOrLoser).reduce((a,r)=>a+r.marksAwarded,0);
  if(Math.abs(total-s.total)>1e-9) problems.push(`${s.roll}: recomputed total ${total} != exported total ${s.total}`);
  // student intelligence (same shape the app already stores)
  const byType={}; reports.filter(r=>!r._runtimeOrLoser).forEach(r=>{const t=r.questionType; (byType[t]??={type:t,scored:0,max:0,count:0}); byType[t].scored+=r.marksAwarded; byType[t].max+=r.maxMarksForQuestion; byType[t].count++;});
  const qtp=Object.values(byType).map(t=>({...t,pct:t.max?Math.round(t.scored/t.max*100):0}));
  const pct=t=>qtp.find(x=>x.type===t)?.pct??0;
  const intel={questionTypePerformance:qtp,summary:{totalMarksLost:Math.max(0,(P.declaredTotal||0)-total),marksLostByType:qtp.map(t=>({type:t.type,marksLost:t.max-t.scored,pct:t.pct})),derivationPct:pct('DERIVATION'),recallPct:pct('RECALL'),numericalPct:pct('NUMERICAL')}};
  // pen annotations -> the existing viewer's 1000x1000 'meet' space (adds the vertical centring offset)
  const pencil={}; s.pages.forEach((pg,pi)=>{const strokes=[]; Object.values(s.ink||{}).forEach(doc=>((doc.pages||{})[String(pi)]||[]).forEach(st=>{ if(!pg.w||!pg.h||!st.d)return;   /* text notes have no path; they are passed to the analysis as manifest.notes */ const H=1000*pg.h/pg.w; const off=(H-1000)/2; strokes.push(st.d.replace(/([ML])\s*([\d.]+)\s+([\d.]+)/g,(_m,c,x,y)=>`${c} ${x} ${(parseFloat(y)-off).toFixed(1)}`)); })); if(strokes.length)pencil[pi]=strokes;});
  plan.push({s,reports,total,intel,pencil,fb});
 }
 console.log(`Students ready to finalize: ${plan.length}/${man.students.length}`);
 if(problems.length){console.log('\nPROBLEMS ('+problems.length+'):');problems.forEach(p=>console.log(' - '+p)); if(WRITE){console.log('\nRefusing to write while problems exist. Fix feedback files and re-run.');process.exit(2);} }
 if(!WRITE){console.log('\nDry run only. Re-run with --write to save.');return;}
 const owner=db.collection('teachers').doc(P.owner).collection('assessmentHistory').doc(P.id);
 for(const {s,reports,total,intel,pencil,fb} of plan){
  const sub=owner.collection('submissions').doc(s.studentUid);
  await sub.set({studentName:s.name,studentUid:s.studentUid,rollNumber:s.roll,maximumMarks:P.declaredTotal,overallScore:total,studentKeywords:[],studentIntelligence:intel,
    gradingTimestamp:new Date().toISOString(),assessmentId:P.id,subject:P.subject,className:P.className,section:P.section,requiresReview:false,
    answerSheetImageUrls:s.pages.map(p=>p.url),pencilAnnotations:pencil,
    overallFeedback:{summary:fb.summary||'',areasForImprovement:fb.areasForImprovement||[],strengths:fb.strengths||[],nextSteps:fb.nextSteps||[]},
    teacherVerified:false,teacherVerifications:{},published:false,source:'teacher_marking'});
  await sub.collection('detail').doc('report').set({questionWiseReport:reports,fullOcrText:''});
  console.log('  wrote',s.roll,s.name,`${total}/${P.declaredTotal}`);
 }
 if(COMPLETE){
  const all=await owner.collection('submissions').listDocuments(); let pending=0; for(const d of all){ if(d.id==='_meta')continue; const doc=await d.get(); if(!doc.exists){ const o=(await d.collection('detail').doc('osm').get()).data(); if(o?.pages?.length) pending++; } }
  if(pending){console.log(`\n--complete skipped: ${pending} uploaded sheet(s) are not finalized yet (not ready or no feedback).`);return;}
  const base=(await owner.get()).data(); await owner.update({assessmentMode:'osm_done'});
  const rosters=await db.collection('classRosters').where('className','==',P.className).where('section','==',P.section).where('subject','==',P.subject).where('schoolName','==',P.schoolName).get();
  for(const r of rosters.docs){ const x=r.data(); if((x.stream||'')!==(P.stream||'')||x.teacherUid===P.owner)continue;
   const dup=await db.collection('teachers').doc(x.teacherUid).collection('assessmentHistory').where('assessmentTitle','==',base.assessmentTitle).get(); if(dup.docs.some(d=>d.data().className===P.className&&d.data().section===P.section))continue;
   const nref=db.collection('teachers').doc(x.teacherUid).collection('assessmentHistory').doc(); await nref.set({...base,assessmentId:nref.id,createdByTeacherUid:x.teacherUid,teacherName:x.teacherName||'',assessmentMode:'osm_done'}); console.log('  exam copy for co-teacher',x.teacherName); }
  console.log('\nPaper is now a normal exam: teachers verify in the usual report screen, then publish as usual.');
 }
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
