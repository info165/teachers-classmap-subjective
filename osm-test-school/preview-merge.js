// Merges the Newtown preview into ONE paper: "MID - TERM EXAMINATION (Teacher Marking preview)" (9A Science, preview teacher).
// - removes the separate "analysis demo" paper (backup first)
// - restores the reciprocal OR marker on 39.B in THIS preview copy
// - enters the ORIGINAL mid-term marks of Arush and Debnika as if the 3 teachers gave them (Q1-18 / 19-36 / 37-54), all "Marks Given"
// Writes only under the preview teacher's own paper. Never publishes.
const {admin,db}=require('./analysis/common.js'); const fs=require('fs'); const cred=require('./credentials-newtown.json');
const FV=admin.firestore.FieldValue;
const SRC={t:'C26WkULLfIhtEi5m0Cmcq4uoPOd2',a:'q8FxlpfGMcFWUntlEuzr'};
const TEACH=[['C26WkULLfIhtEi5m0Cmcq4uoPOd2','Vishakha Sharma'],['ea5YpdloyOQwm0eSK673CYtMius1','Sujata Dutta'],['wxNKmUO0CTMCbTHgWX6lAyz9yHV2','Annie Ghosh']];
const STUDENTS=['160433','160459'];
(async()=>{
 const col=db.collection('teachers').doc(cred.uid).collection('assessmentHistory');
 const all=await col.where('assessmentMode','==','osm').get();
 const main=all.docs.find(d=>/Teacher Marking preview/.test(d.data().assessmentTitle)&&d.data().section==='A'); const demo=all.docs.find(d=>/analysis demo/.test(d.data().assessmentTitle));
 if(!main) throw new Error('preview paper not found');
 // backup
 const bk={main:main.id,docs:{}}; for(const sd of await main.ref.collection('submissions').listDocuments()){ const det=await sd.collection('detail').get(); bk.docs[sd.id]=Object.fromEntries(det.docs.map(d=>[d.id,d.data()])); }
 fs.writeFileSync('/private/tmp/claude-501/preview-backup-'+Date.now()+'.json',JSON.stringify(bk));
 if(demo){ if(demo.data().createdByTeacherUid!==cred.uid||!/analysis demo/.test(demo.data().assessmentTitle)) throw new Error('refusing to delete'); await db.recursiveDelete(demo.ref); console.log('removed separate demo paper',demo.id); }
 // paper copy: reciprocal OR marker on 39.B
 const qs=main.data().questions.map(q=>q.questionNumber==='39.B'&&!/alternative question \(or\)/i.test(q.checkingInstructions||'')?{...q,checkingInstructions:'Alternative Question (OR) with Question 39.A. Grade first attempt only.\n'+(q.checkingInstructions||'')}:q);
 await main.ref.update({questions:qs});
 // meta: the 3 teachers split the paper; preview teacher's own test assignment removed
 const n=qs.length, third=Math.ceil(n/3), assign={}; TEACH.forEach(([u],k)=>{assign[u]=[]; for(let i=k*third;i<Math.min(n,(k+1)*third);i++) assign[u].push(i);});
 const metaRef=main.ref.collection('submissions').doc('_meta').collection('detail').doc('osm');
 await metaRef.set({assign:{...assign,[cred.uid]:FV.delete()},readyForAnalysis:false},{merge:true});
 // marks
 const srcSubs=db.collection('teachers').doc(SRC.t).collection('assessmentHistory').doc(SRC.a).collection('submissions');
 for(const roll of STUDENTS){
  const sd=(await srcSubs.where('rollNumber','==',roll).get()).docs[0]; const rep=(await sd.ref.collection('detail').doc('report').get()).data();
  const by=Object.fromEntries(rep.questionWiseReport.map(q=>[String(q.questionNumber),q.marksAwarded||0]));
  const marks={},done={}; const now=Date.now();
  TEACH.forEach(([u,name])=>{ assign[u].forEach(i=>{ const q=qs[i]; marks['q'+i]={v:by[String(q.questionNumber)]??0,by:u,n:name,t:now}; }); done[u]={n:name,t:now}; });
  const ref=main.ref.collection('submissions').doc(sd.id).collection('detail').doc('osm');
  const cur=(await ref.get()).data(); if(!cur||!cur.pages?.length) throw new Error('no sheet for '+roll);
  await ref.update({marks,done,notes:FV.delete(),updatedAt:now}); // replaces the whole marks/done maps
  console.log('marks entered',roll,cur.studentName,'original total',sd.data().overallScore);
 }
 console.log('merged into',main.id);
})().catch(e=>{console.error(e);process.exit(1)});
