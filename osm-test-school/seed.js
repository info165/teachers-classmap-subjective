// Seeds an isolated dummy school "OSM Test School" (Auth users + Firestore docs).
// Idempotent: deterministic emails/ids, skips what exists. Usage: node seed.js [--dry]
const admin=require('/Users/nikhar/Desktop/Teachers-classmap-Project/vertex-ai-backend/node_modules/firebase-admin');
const fs=require('fs');
admin.initializeApp({credential:admin.credential.cert(require('/Users/nikhar/Desktop/Teachers-classmap-Project/functions/serviceAccountKey.json.json'))});
const db=admin.firestore(), auth=admin.auth();
const DRY=process.argv.includes('--dry');
const SCHOOL='OSM Test School', DOM='osmtest.classmap.in', PASSWORD='OsmTest@'+'2026';
const slug=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,'');
// class -> sections [{sec, stream, subjects}]
const PLAN={
 '9':[{sec:'A',stream:'',n:10,subs:['English','Maths','Science','Social Science','Artificial Intelligence']},
      {sec:'B',stream:'',n:10,subs:['English','Maths','Science','Social Science','Artificial Intelligence']}],
 '11':[{sec:'A',stream:'Science',n:10,subs:['English','Physics','Chemistry','Mathematics','Biology','Computer Science','Physical Education']},
       {sec:'B',stream:'Commerce',n:10,subs:['English','Accountancy','Business Studies','Economics','Applied Mathematics']},
       {sec:'C',stream:'Humanities',n:8,subs:['English','History','Geography','Political Science','Psychology']}]};
const FIRST=['Aarav','Diya','Kabir','Meera','Rohan','Sana','Vihaan','Ishita','Arjun','Tara'];
const LAST=['Test','Sample','Demo'];
const creds={school:SCHOOL,password:PASSWORD,admin:null,teachers:[],students:[]};
const allSubjects=[...new Set(Object.values(PLAN).flat().flatMap(x=>x.subs))];
(async()=>{
 const plan={teachers:allSubjects.length*3,students:0,rosters:0};
 Object.entries(PLAN).forEach(([c,secs])=>secs.forEach(s=>{plan.students+=s.n;plan.rosters+=s.subs.length*3}));
 console.log('PLAN',JSON.stringify({subjects:allSubjects.length,...plan,admin:1}));
 if(DRY)return;
 async function ensureUser(email,name){ try{return (await auth.getUserByEmail(email)).uid;}catch(e){ return (await auth.createUser({email,password:PASSWORD,displayName:name,emailVerified:true})).uid; } }
 const adminEmail=`principal@${DOM}`; const adminUid=await ensureUser(adminEmail,'OSM Test Principal');
 creds.admin={email:adminEmail,uid:adminUid};
 const features={teacherHomeworkCreation_fromBook:false,teacherHomeworkCreation_myQuestions:true,teacherHomeworkCreation_usingAI:false,teacherAssessmentCreation_fromBook:false,teacherAssessmentCreation_myQuestions:true,teacherAssessmentCreation_usingAI:false,teacherAssessmentGrading:true,teacherAssessmentGrading_scores:true,teacherAssessmentGrading_feedback:true,teacherAssessmentGrading_osm:true,teacherAssessmentGrading_improvementAreas:true,teacherPersonalizedWorksheets:false,teacherAnalyticsHub:true,studentPortfolioView:true,managementAnalyticsDashboard:true,studentAIDoubtSolver:false,studentInterviewPractice:false,studentCareerGuidance:false,studentAssignmentsView:false};
 await db.collection('schools').doc(adminUid).set({email:adminEmail,adminName:'OSM Test Principal',boardName:'CBSE',displayName:SCHOOL,schoolName:SCHOOL,features,totalCredits:1000000,remainingCredits:1000000,isTestSchool:true},{merge:true});
 // teachers: 3 per subject
 const teachersBySubject={};
 for(const sub of allSubjects){ teachersBySubject[sub]=[];
  const classes=[...new Set(Object.entries(PLAN).filter(([c,secs])=>secs.some(s=>s.subs.includes(sub))).map(([c])=>c))];
  for(let i=1;i<=3;i++){ const email=`${slug(sub)}.teacher${i}@${DOM}`; const name=`${sub} Teacher ${i}`;
   const uid=await ensureUser(email,name);
   await db.collection('teachers').doc(uid).set({schoolName:SCHOOL,boardName:'CBSE',name,email,phone:'',address:'',pinCode:'',emergencyContact:'',welcomeEmailSent:true,uid,classesTaught:classes,subjectsTaught:[sub],schoolId:adminUid,isTestAccount:true},{merge:true});
   teachersBySubject[sub].push({uid,name,email}); creds.teachers.push({subject:sub,name,email,uid}); }}
 // students + rosters
 for(const [cls,secs] of Object.entries(PLAN)) for(const s of secs){
  const roster=[];
  for(let i=0;i<s.n;i++){ const roll=`${cls}${s.sec}${String(i+1).padStart(2,'0')}`; const name=`${FIRST[i%FIRST.length]} ${LAST[i%LAST.length]} ${cls}${s.sec}${i+1}`; const email=`${roll.toLowerCase()}@${DOM}`;
   const uid=await ensureUser(email,name);
   await db.collection('students').doc(uid).set({school:SCHOOL,boardName:'',rollNumber:roll,studentClass:cls,studentSection:s.sec,stream:s.stream,email,phone:'',fatherName:'',motherName:'',city:'',pincode:'',isSubscribed:false,welcomeEmailSent:true,uid,subjectsEnrolled:s.subs.join(','),name,isTestAccount:true},{merge:true});
   roster.push({status:'active',uid,email,name,rollNumber:roll}); creds.students.push({class:cls,section:s.sec,stream:s.stream,name,email,uid,roll}); }
  for(const sub of s.subs) for(const t of teachersBySubject[sub]){
   const id=`${t.uid}_${cls}_${s.sec}_${sub.replace(/ /g,'_')}_${s.stream||'General'}`;
   await db.collection('classRosters').doc(id).set({teacherUid:t.uid,teacherName:t.name,teacherEmail:t.email,schoolName:SCHOOL,board:'CBSE',className:cls,section:s.sec,subject:sub,stream:s.stream,id,inviteCode:'OSM'+Math.random().toString(36).slice(2,8).toUpperCase(),students:roster,remainingCredits:100000,totalAssignedCredits:100000,isTestRoster:true},{merge:true}); }
  console.log('seeded',cls,s.sec,s.stream);
 }
 fs.writeFileSync('/Users/nikhar/Desktop/Teachers-classmap-Project/osm-test-school/credentials.json',JSON.stringify(creds,null,1));
 console.log('DONE teachers',creds.teachers.length,'students',creds.students.length);
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
