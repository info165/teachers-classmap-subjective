// One student login used ONLY for previewing Teacher Marking reports of the Newtown preview paper.
// Creates: 1 Auth user, 1 students doc, and teachers/<preview teacher>.previewStudentUid. Publishing a preview paper goes here, never to real students.
// Password is stored in credentials-newtown.json (git-excluded) and not printed. Usage: node preview-student.js
const {admin,db}=require('./analysis/common.js'); const fs=require('fs'), crypto=require('crypto');
const EMAIL='marking.student.preview@classmap.in', NAME='Preview Student';
(async()=>{
 const credPath=__dirname+'/credentials-newtown.json'; const cred=JSON.parse(fs.readFileSync(credPath,'utf8'));
 let uid; try{uid=(await admin.auth().getUserByEmail(EMAIL)).uid; console.log('student auth user already exists');}catch{
   const pw=crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g,'x')+'!7a';
   uid=(await admin.auth().createUser({email:EMAIL,password:pw,displayName:NAME,emailVerified:true})).uid; cred.student={email:EMAIL,password:pw,uid}; fs.writeFileSync(credPath,JSON.stringify(cred,null,1)); console.log('created student auth user (password saved in credentials-newtown.json)'); }
 await db.collection('students').doc(uid).set({school:'New Town School',boardName:'CBSE',rollNumber:'PREVIEW',studentClass:'9',studentSection:'A',stream:'',email:EMAIL,phone:'',fatherName:'',motherName:'',city:'',pincode:'',isSubscribed:false,welcomeEmailSent:true,uid,subjectsEnrolled:'Science',name:NAME,isTestAccount:true},{merge:true});
 await db.collection('teachers').doc(cred.uid).set({previewStudentUid:uid},{merge:true});
 console.log('preview student',EMAIL,uid,'linked to preview teacher',cred.uid);
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
