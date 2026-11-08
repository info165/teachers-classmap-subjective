// LIVE Newtown trial papers: copies ONE student's marks per paper from the real teacher's original mid-term marking (marks only; nothing else).
// Writes only the 'marks' field of that student's new Teacher Marking document. The teacher still clicks Completed herself.
// Usage: node newtown-live-mark.js [--write]
const {db}=require('./analysis/common.js'); const WRITE=process.argv.includes('--write');
const TITLE='MID - TERM EXAMINATION (Teacher Marking trial)'; const PICK={English:'151015'};   // first student by roll; English has no sheet for 151007
(async()=>{
 const ts=await db.collection('teachers').where('schoolName','==','New Town School').get();
 for(const t of ts.docs){ const ps=await t.ref.collection('assessmentHistory').where('assessmentTitle','==',TITLE).get();
  for(const p of ps.docs){ const x=p.data(); if(!x.liveTrialOf)continue;
   const subs=await p.ref.collection('submissions').listDocuments(); const rows=[]; for(const s of subs){ if(s.id==='_meta')continue; const o=(await s.collection('detail').doc('osm').get()).data(); if(o) rows.push({uid:s.id,o}); }
   rows.sort((a,b)=>String(a.o.rollNumber).localeCompare(String(b.o.rollNumber),undefined,{numeric:true})); const pickRoll=PICK[x.subject]||rows[0].o.rollNumber; const st=rows.find(r=>r.o.rollNumber===pickRoll);
   const src=db.collection('teachers').doc(x.liveTrialOf.owner).collection('assessmentHistory').doc(x.liveTrialOf.paperId).collection('submissions').doc(st.uid);
   const [sp,sr]=await Promise.all([src.get(),src.collection('detail').doc('report').get()]); const rep=(sr.exists?sr.data().questionWiseReport:null)||(sp.data()||{}).questionWiseReport||[];
   const byQ=Object.fromEntries(rep.map(q=>[String(q.questionNumber),Number(q.marksAwarded)||0]));
   const marks={}; let missing=0, total=0; const now=Date.now();
   x.questions.forEach((q,i)=>{ const qn=String(q.questionNumber||i+1); if(!(qn in byQ)){missing++;return;} marks['q'+i]={v:byQ[qn],by:t.id,n:t.data().name,t:now}; total+=byQ[qn]; });
   console.log(`${x.subject} ${x.className}${x.section} | ${st.o.rollNumber} ${st.o.studentName} | ${Object.keys(marks).length}/${x.questions.length} questions | sum of question marks ${total} | original total ${(sp.data()||{}).overallScore} | missing ${missing} | by ${t.data().name}`);
   if(WRITE&&missing===0) { await p.ref.collection('submissions').doc(st.uid).collection('detail').doc('osm').set({marks,updatedAt:Date.now()},{merge:true}); console.log('   written'); } else if(WRITE) console.log('   NOT written (missing questions)');
  } }
 if(!WRITE) console.log('\nDry run only.');
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
