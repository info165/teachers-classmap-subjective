// Loads Newtown Class 9 Science MID-TERM (A,B,C) into Teacher Marking under ONE dedicated preview teacher.
// READS real papers/submissions; WRITES only: 1 new Auth user, 1 teachers doc, 3 classRosters docs,
// 3 osm papers + per-student detail/osm docs (under the preview teacher), and school.features.teacherManualMarking.
// Real answer-sheet images are REFERENCED by URL (no copy, no deletes anywhere in Teacher Marking).
// Usage: node newtown-load.js [--write]
const {admin,db}=require('./analysis/common.js');
const fs=require('fs'), crypto=require('crypto');
const WRITE=process.argv.includes('--write');
const SID='W8Ey4uxmXUfnBWoacQGWOgffddX2', SCHOOL='New Town School';
const EMAIL='marking.preview@classmap.in', NAME='Teacher Marking Preview';
const SOURCES={A:['C26WkULLfIhtEi5m0Cmcq4uoPOd2','q8FxlpfGMcFWUntlEuzr'],B:['4wPBUANwpWddIgTh5bE9HzodrFP2','uheEPwG5AnsE9gyZnVgH'],C:['4wPBUANwpWddIgTh5bE9HzodrFP2','nzuzHAl7V6slYjKwDCUj']};
const TITLE='MID - TERM EXAMINATION (Teacher Marking preview)';
const pathOf=u=>{try{return decodeURIComponent(new URL(u).pathname.split('/o/')[1]);}catch{return '';}};
(async()=>{
 const out={dry:!WRITE,papers:[]};
 // preview teacher
 let uid; try{uid=(await admin.auth().getUserByEmail(EMAIL)).uid;}catch{uid=null;}
 const pw=crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g,'x')+'!7a';
 if(WRITE&&!uid){uid=(await admin.auth().createUser({email:EMAIL,password:pw,displayName:NAME,emailVerified:true})).uid;
   fs.writeFileSync(__dirname+'/credentials-newtown.json',JSON.stringify({school:SCHOOL,email:EMAIL,password:pw,uid},null,1));}
 uid=uid||'(new)';
 console.log('preview teacher',EMAIL,uid);
 if(WRITE){ await db.collection('teachers').doc(uid).set({schoolName:SCHOOL,schoolId:SID,boardName:'CBSE',name:NAME,email:EMAIL,phone:'',address:'',pinCode:'',emergencyContact:'',welcomeEmailSent:true,uid,classesTaught:['9'],subjectsTaught:['Science'],isPreviewTeacher:true},{merge:true}); }
 for(const sec of ['A','B','C']){
  const [ownerUid,paperId]=SOURCES[sec];
  const pref=db.collection('teachers').doc(ownerUid).collection('assessmentHistory').doc(paperId);
  const p=(await pref.get()).data();
  const subs=await pref.collection('submissions').get();
  const stu=[]; subs.forEach(s=>{const d=s.data(); const urls=d.answerSheetImageUrls||[]; if(urls.length) stu.push({uid:s.id,name:d.studentName||'',roll:d.rollNumber||'',urls});});
  const qsize=Buffer.byteLength(JSON.stringify(p.questions));
  // roster: the real owner's roster for this section
  const rs=await db.collection('classRosters').where('teacherUid','==',ownerUid).where('className','==','9').where('section','==',sec).where('subject','==','Science').get();
  const real=rs.docs[0]?.data();
  console.log(`9${sec}: q=${p.questions.length} total=${p.totalMarks} qBytes=${qsize} studentsWithSheets=${stu.length} pages=${stu.reduce((a,s)=>a+s.urls.length,0)} roster=${real?real.students.length:'MISSING'}`);
  out.papers.push({sec,q:p.questions.length,stu:stu.length});
  if(!WRITE) continue;
  if(!real) throw new Error('no roster 9'+sec);
  const rid=`${uid}_9_${sec}_Science_General`;
  await db.collection('classRosters').doc(rid).set({teacherUid:uid,teacherName:NAME,teacherEmail:EMAIL,schoolName:SCHOOL,board:'CBSE',className:'9',section:sec,subject:'Science',stream:'',id:rid,inviteCode:'MKPREV'+sec,remainingCredits:0,totalAssignedCredits:0,students:real.students});
  const id=pref.parent.doc().id;
  const paper=db.collection('teachers').doc(uid).collection('assessmentHistory').doc(id);
  await paper.set({assessmentId:id,assessmentMode:'osm',createdByTeacherUid:uid,teacherName:NAME,schoolName:SCHOOL,board:'CBSE',subject:'Science',className:'9',section:sec,stream:'',assessmentTitle:TITLE,questions:p.questions,totalMarks:p.totalMarks,creationTimestamp:new Date().toISOString(),source:'question_images',difficultyLevel:'',checkingStrictness:'Moderate',selectedChapters:[],topics:[],generalInstructions:'',previewCopyOf:{owner:ownerUid,paperId}});
  for(const s of stu){
   await paper.collection('submissions').doc(s.uid).collection('detail').doc('osm').set({studentUid:s.uid,studentName:s.name,rollNumber:s.roll,pages:s.urls.map(u=>({url:u,path:pathOf(u)})),uploadedBy:uid,updatedAt:Date.now(),referencedFromOriginal:true});
  }
  console.log(' wrote paper',id,'students',stu.length);
 }
 if(WRITE){
  const sref=db.collection('schools').doc(SID); const sd=(await sref.get()).data();
  fs.writeFileSync(__dirname+'/newtown-flag-before.json',JSON.stringify({teacherManualMarking:(sd.features||{}).teacherManualMarking===undefined?'(unset)':sd.features.teacherManualMarking}));
  await sref.set({features:{teacherManualMarking:true}},{merge:true});
  console.log('flag teacherManualMarking=true on',SID);
 }
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
