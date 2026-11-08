// LIVE Newtown: creates Teacher Marking trial papers inside the REAL teachers' accounts, for Class 9 Section A, 5 students each.
// Reads the school's real mid-term (paper + sheets), writes ONLY new documents (never edits or deletes existing exams/results):
//   teachers/<original subject teacher>/assessmentHistory/<new id>  (assessmentMode:'osm')  and  .../submissions/<student>/detail/osm  (sheet pictures referenced by URL).
// Usage: node newtown-live-setup.js            (dry run: shows exactly what it would create)
//        node newtown-live-setup.js --write
const {db}=require('./analysis/common.js'); const WRITE=process.argv.includes('--write');
const SCHOOL='New Town School', CLASS='9', SECTION='A', N=5;
const TITLE='MID - TERM EXAMINATION (Teacher Marking trial)';
const SUBJECTS={Science:/^MID - TERM EXAMINATION$/i,'Maths':/MID - TERM EXAMINATION-Mathematics/i,English:/^MID - TERM EXAMINATION$/i,'Social Science':/^MID-TERM EXAMINATION$/i,'Artificial Intelligence':/MID - TERM EXAMINATION_AI/i};
const pathOf=u=>{try{return decodeURIComponent(new URL(u).pathname.split('/o/')[1]);}catch{return '';}};
(async()=>{
 const ts=await db.collection('teachers').where('schoolName','==',SCHOOL).get();
 for(const [subject,re] of Object.entries(SUBJECTS)){
  console.log('\n=== Class',CLASS+SECTION,subject);
  // roster teachers (= who will see the paper and appear in "Teachers done")
  const rs=await db.collection('classRosters').where('schoolName','==',SCHOOL).where('className','==',CLASS).where('section','==',SECTION).where('subject','==',subject).get();
  const rosters=rs.docs.map(d=>d.data()).filter(r=>!(r.stream||'')); console.log(' roster teachers:',rosters.map(r=>r.teacherName+' ('+(r.students||[]).length+' students)').join(', '));
  const rosterUids=new Set(); rosters.forEach(r=>(r.students||[]).forEach(s=>s&&s.uid&&rosterUids.add(s.uid)));
  // the original mid-term with sheets: the one with most submissions that have sheets
  let best=null;
  for(const t of ts.docs){ if(!rosters.some(r=>r.teacherUid===t.id)) continue; const as=await t.ref.collection('assessmentHistory').where('className','==',CLASS).where('section','==',SECTION).where('subject','==',subject).get();
    for(const a of as.docs){ const x=a.data(); if(x.assessmentMode==='osm'||!re.test(x.assessmentTitle||''))continue; const subs=await a.ref.collection('submissions').get(); let n=0; subs.forEach(s=>{if((s.data().answerSheetImageUrls||[]).length)n++;}); if(!best||n>best.n) best={t,a,x,subs,n}; } }
  if(!best){console.log(' !! no original mid-term with sheets found - skipped');continue;}
  console.log(' original:',best.x.assessmentTitle,'| questions',(best.x.questions||[]).length,'| total',best.x.totalMarks,'| by',best.t.data().name,'| sheets',best.n);
  const col=best.t.ref.collection('assessmentHistory'); const exist=await col.where('assessmentTitle','==',TITLE).get();
  if(!exist.empty){console.log(' already created:',exist.docs[0].id,'- skipped');continue;}
  const cand=[]; best.subs.forEach(s=>{const d=s.data(); const u=d.answerSheetImageUrls||[]; if(u.length&&rosterUids.has(s.id)) cand.push({uid:s.id,name:d.studentName||'',roll:d.rollNumber||'',urls:u});});
  cand.sort((a,b)=>String(a.roll).localeCompare(String(b.roll),undefined,{numeric:true})); const pick=cand.slice(0,N);
  console.log(' students:',pick.map(p=>p.roll+' '+p.name+' ('+p.urls.length+' pages)').join(' | '));
  if(!WRITE) continue;
  const ref=col.doc(); const id=ref.id; const x=best.x;
  await ref.set({assessmentId:id,assessmentMode:'osm',createdByTeacherUid:best.t.id,teacherName:best.t.data().name,schoolName:x.schoolName||SCHOOL,board:x.board||'CBSE',subject,className:CLASS,section:SECTION,stream:x.stream||'',assessmentTitle:TITLE,questions:x.questions,totalMarks:x.totalMarks,creationTimestamp:new Date().toISOString(),source:'question_images',difficultyLevel:'',checkingStrictness:'Moderate',selectedChapters:[],topics:[],generalInstructions:'',liveTrialOf:{owner:best.t.id,paperId:best.a.id}});
  for(const p of pick) await ref.collection('submissions').doc(p.uid).collection('detail').doc('osm').set({studentUid:p.uid,studentName:p.name,rollNumber:p.roll,pages:p.urls.map(u=>({url:u,path:pathOf(u)})),uploadedBy:best.t.id,updatedAt:Date.now(),referencedFromOriginal:true});
  console.log(' CREATED',id,'with',pick.length,'students');
 }
 if(!WRITE) console.log('\nDry run only. Re-run with --write to create.');
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
