// Puts ONE analysed exam into the Newtown PREVIEW teacher's account (marking.preview@classmap.in): Arush Majumder, 9A Science.
// Marks = the original verified mid-term marks, entered under the preview teacher. Writes only under the preview teacher. Never publishes.
const {db}=require('./analysis/common.js'); const cred=require('./credentials-newtown.json');
const SRC={t:'C26WkULLfIhtEi5m0Cmcq4uoPOd2',a:'q8FxlpfGMcFWUntlEuzr',s:'KQJYnHVZT8fIAUs2VV8eD3LdPhD2'};
const TITLE='Mid-Term Examination (analysis demo)'; const pathOf=u=>{try{return decodeURIComponent(new URL(u).pathname.split('/o/')[1]);}catch{return '';}};
(async()=>{
 const col=db.collection('teachers').doc(cred.uid).collection('assessmentHistory');
 if(!(await col.where('assessmentTitle','==',TITLE).get()).empty){console.log('already exists');return;}
 const srcRef=db.collection('teachers').doc(SRC.t).collection('assessmentHistory').doc(SRC.a); const P=(await srcRef.get()).data();
 const sub=(await srcRef.collection('submissions').doc(SRC.s).get()).data(); const rep=(await srcRef.collection('submissions').doc(SRC.s).collection('detail').doc('report').get()).data();
 const by=Object.fromEntries(rep.questionWiseReport.map(q=>[String(q.questionNumber),q.marksAwarded||0]));
 // my COPY of the paper: restore the reciprocal OR marker on 39.B (the original instruction was replaced by a note)
 const qs=P.questions.map(q=>q.questionNumber==='39.B'&&!/alternative question \(or\)/i.test(q.checkingInstructions||'')?{...q,checkingInstructions:'Alternative Question (OR) with Question 39.A. Grade first attempt only.\n'+(q.checkingInstructions||'')}:q);
 const ref=col.doc(); await ref.set({assessmentId:ref.id,assessmentMode:'osm',createdByTeacherUid:cred.uid,teacherName:'Teacher Marking Preview',schoolName:cred.school,board:'CBSE',subject:'Science',className:'9',section:'A',stream:'',assessmentTitle:TITLE,questions:qs,totalMarks:80,creationTimestamp:new Date().toISOString(),source:'question_images',difficultyLevel:'',checkingStrictness:'Moderate',selectedChapters:[],topics:[],generalInstructions:'',previewCopyOf:{owner:SRC.t,paperId:SRC.a}});
 const marks={}; qs.forEach((q,i)=>{marks['q'+i]={v:by[String(q.questionNumber)]??0,by:cred.uid,n:'Teacher Marking Preview',t:Date.now()};});
 await ref.collection('submissions').doc(SRC.s).collection('detail').doc('osm').set({studentUid:SRC.s,studentName:sub.studentName,rollNumber:sub.rollNumber,pages:sub.answerSheetImageUrls.map(u=>({url:u,path:pathOf(u)})),marks,done:{[cred.uid]:{n:'Teacher Marking Preview',t:Date.now()}},uploadedBy:cred.uid,updatedAt:Date.now(),referencedFromOriginal:true});
 console.log('created',ref.id,sub.studentName,sub.rollNumber);
})().catch(e=>{console.error(e);process.exit(1)});
