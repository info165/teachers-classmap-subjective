// LIVE Newtown trial papers: attaches the NEXT 5 students' real answer sheets (by roll number) to each trial paper. No marks are written.
// Only creates new submissions/<student>/detail/osm documents (sheet pictures referenced by URL). Usage: node newtown-live-addstudents.js [--write]
const {db}=require('./analysis/common.js'); const WRITE=process.argv.includes('--write'); const N=5;
const TITLE='MID - TERM EXAMINATION (Teacher Marking trial)';
const pathOf=u=>{try{return decodeURIComponent(new URL(u).pathname.split('/o/')[1]);}catch{return '';}};
(async()=>{
 const ts=await db.collection('teachers').where('schoolName','==','New Town School').get();
 for(const t of ts.docs){ const ps=await t.ref.collection('assessmentHistory').where('assessmentTitle','==',TITLE).get();
  for(const p of ps.docs){ const x=p.data(); if(!x.liveTrialOf)continue;
   const have=new Set((await p.ref.collection('submissions').listDocuments()).map(d=>d.id));
   const rs=await db.collection('classRosters').where('schoolName','==','New Town School').where('className','==',x.className).where('section','==',x.section).where('subject','==',x.subject).get();
   const ru=new Set(); rs.docs.forEach(r=>(r.data().students||[]).forEach(s=>s&&s.uid&&ru.add(s.uid)));
   const src=db.collection('teachers').doc(x.liveTrialOf.owner).collection('assessmentHistory').doc(x.liveTrialOf.paperId).collection('submissions'); const subs=await src.get();
   const cand=[]; subs.forEach(s=>{const d=s.data(),u=d.answerSheetImageUrls||[]; if(u.length&&ru.has(s.id)&&!have.has(s.id)) cand.push({uid:s.id,name:d.studentName||'',roll:d.rollNumber||'',urls:u});});
   cand.sort((a,b)=>String(a.roll).localeCompare(String(b.roll),undefined,{numeric:true})); const pick=cand.slice(0,N);
   console.log(x.subject,'9'+x.section,'| already',have.size,'| adding:',pick.map(q=>q.roll+' '+q.name+' ('+q.urls.length+'p)').join(' | '));
   if(WRITE) for(const q of pick) await p.ref.collection('submissions').doc(q.uid).collection('detail').doc('osm').set({studentUid:q.uid,studentName:q.name,rollNumber:q.roll,pages:q.urls.map(u=>({url:u,path:pathOf(u)})),uploadedBy:t.id,updatedAt:Date.now(),referencedFromOriginal:true});
  } }
 if(!WRITE)console.log('\nDry run only.');
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
