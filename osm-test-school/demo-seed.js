// DEMO: one dummy-school student gets a real Newtown handwritten sheet (images referenced by URL) and the marks
// of the original mid-term, split between the 3 dummy Science teachers (Q1-18 / 19-36 / 37-54), all "Marks Given".
// Writes ONLY inside the OSM Test School (dummy teachers' own assessmentHistory). Usage: node demo-seed.js
const {db}=require('./analysis/common.js');
const cred=require('./credentials.json');
const SRC={t:'C26WkULLfIhtEi5m0Cmcq4uoPOd2',a:'q8FxlpfGMcFWUntlEuzr',s:'KQJYnHVZT8fIAUs2VV8eD3LdPhD2'};   // original Newtown 9A Science mid-term, Arush
const TITLE='Mid-Term Examination (demo)';
const pathOf=u=>{try{return decodeURIComponent(new URL(u).pathname.split('/o/')[1]);}catch{return '';}};
(async()=>{
 const T=cred.teachers.filter(t=>t.subject==='Science').sort((a,b)=>a.name.localeCompare(b.name));
 const stu=cred.students.find(s=>s.roll==='9A01'); if(!stu||T.length<3) throw new Error('credentials missing');
 const srcRef=db.collection('teachers').doc(SRC.t).collection('assessmentHistory').doc(SRC.a);
 const paperSrc=(await srcRef.get()).data();
 const sub=(await srcRef.collection('submissions').doc(SRC.s).get()).data();
 const rep=(await srcRef.collection('submissions').doc(SRC.s).collection('detail').doc('report').get()).data();
 const byQ=Object.fromEntries(rep.questionWiseReport.map(q=>[String(q.questionNumber),q.marksAwarded||0]));
 const owner=T[0];
 const col=db.collection('teachers').doc(owner.uid).collection('assessmentHistory');
 const old=await col.where('assessmentTitle','==',TITLE).get(); if(!old.empty){console.log('demo paper already exists:',old.docs[0].id);return;}
 const ref=col.doc(); const id=ref.id;
 await ref.set({assessmentId:id,assessmentMode:'osm',createdByTeacherUid:owner.uid,teacherName:owner.name,schoolName:cred.school,board:'CBSE',subject:'Science',className:'9',section:'A',stream:'',assessmentTitle:TITLE,questions:paperSrc.questions,totalMarks:80,creationTimestamp:new Date().toISOString(),source:'question_images',difficultyLevel:'',checkingStrictness:'Moderate',selectedChapters:[],topics:[],generalInstructions:'',demo:true});
 const n=paperSrc.questions.length, third=Math.ceil(n/3), assign={}, marks={}, done={};
 T.slice(0,3).forEach((t,k)=>{ assign[t.uid]=[]; for(let i=k*third;i<Math.min(n,(k+1)*third);i++){ assign[t.uid].push(i); const q=paperSrc.questions[i]; marks['q'+i]={v:byQ[String(q.questionNumber)]??0,by:t.uid,n:t.name,t:Date.now()}; } done[t.uid]={n:t.name,t:Date.now()}; });
 await ref.collection('submissions').doc('_meta').collection('detail').doc('osm').set({assign});
 await ref.collection('submissions').doc(stu.uid).collection('detail').doc('osm').set({studentUid:stu.uid,studentName:stu.name,rollNumber:stu.roll,pages:sub.answerSheetImageUrls.map(u=>({url:u,path:pathOf(u)})),marks,done,uploadedBy:owner.uid,updatedAt:Date.now(),referencedFromOriginal:true});
 console.log('demo paper',id,'owner',owner.name,'student',stu.name,'assign',Object.fromEntries(T.map(t=>[t.name,(assign[t.uid]||[]).length])));
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
