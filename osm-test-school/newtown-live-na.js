// LIVE Newtown trial paper: marks the questions the student did NOT attempt as "not attempted" (N/A) for the already-marked student (only questions currently marked 0).
// Usage: node newtown-live-na.js "<Subject>" <q-index,q-index,...>
const {db}=require('./analysis/common.js'); const [,,subject,list]=process.argv; const idx=String(list||'').split(',').filter(Boolean).map(Number);
const TITLE='MID - TERM EXAMINATION (Teacher Marking trial)';
(async()=>{
 const ts=await db.collection('teachers').where('schoolName','==','New Town School').get();
 for(const t of ts.docs){ const ps=await t.ref.collection('assessmentHistory').where('assessmentTitle','==',TITLE).where('subject','==',subject).get();
  for(const p of ps.docs){ const x=p.data(); if(!x.liveTrialOf)continue; const subs=await p.ref.collection('submissions').listDocuments();
   for(const s of subs){ if(s.id==='_meta')continue; const ref=s.collection('detail').doc('osm'); const o=(await ref.get()).data()||{}; if(!o.marks||Object.keys(o.marks).length<5)continue;
    const patch={}; for(const i of idx){ const m=o.marks['q'+i]; if(!m||m.v!==0){console.log('  SKIP q'+i,'(not a 0 mark)',m&&m.v);continue;} patch['q'+i]={v:0,na:true,by:m.by,n:m.n,t:Date.now()}; }
    await ref.set({marks:patch,updatedAt:Date.now()},{merge:true}); console.log(subject,o.studentName,'-> N/A on',Object.keys(patch).length,'questions'); } } }
})();
