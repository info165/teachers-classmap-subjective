// Usage: node export.js "<School Name>" [className] [section] [subject]
// Finds Teacher Marking papers (assessmentMode 'osm') whose students are READY (all questions marked,
// every contributing teacher clicked Marks Given) and exports marks + page images to ./work/<paper>/
// so Claude can read the handwriting and write feedback. READ-ONLY on Firestore.
const {db}=require('./common'); const fs=require('fs'),path=require('path'),https=require('https'),cp=require('child_process');
const [,, school, fc, fs_, fsub]=process.argv; if(!school){console.log('usage: node export.js "School" [class] [section] [subject]');process.exit(1);}
const slug=s=>String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const dl=(u,f)=>new Promise((res,rej)=>{https.get(u,r=>{if(r.statusCode!==200)return rej(new Error('HTTP '+r.statusCode));const w=fs.createWriteStream(f);r.pipe(w);w.on('finish',()=>w.close(res));}).on('error',rej);});
(async()=>{
 const teachers=await db.collection('teachers').where('schoolName','==',school).get(); const seen=new Set(); const out=[];
 for(const t of teachers.docs){
  const ps=await t.ref.collection('assessmentHistory').where('assessmentMode','==','osm').get();
  for(const p of ps.docs){ const x=p.data(); if(fc&&String(x.className)!==fc)continue; if(fs_&&x.section!==fs_)continue; if(fsub&&x.subject!==fsub)continue;
   const key=[x.className,x.section,x.subject,x.stream||'',(x.assessmentTitle||'').trim().toLowerCase()].join('|'); if(seen.has(key))continue; seen.add(key);
   // canonical owner = earliest-created copy among same-key papers (same rule as the app)
   out.push({owner:t.id,id:p.id,x,key,ref:p.ref}); }}
 // resolve canonical owner per key (earliest creationTimestamp across teachers)
 const best=new Map(); for(const t of teachers.docs){const ps=await t.ref.collection('assessmentHistory').where('assessmentMode','==','osm').get(); ps.docs.forEach(p=>{const x=p.data(); const key=[x.className,x.section,x.subject,x.stream||'',(x.assessmentTitle||'').trim().toLowerCase()].join('|'); const c={owner:t.id,id:p.id,x,key,ref:p.ref}; const b=best.get(key); if(!b||(x.creationTimestamp||'')<(b.x.creationTimestamp||'')) best.set(key,c);});}
 for(const P of best.values()){
  if(fc&&String(P.x.className)!==fc||fs_&&P.x.section!==fs_||fsub&&P.x.subject!==fsub)continue;
  const dir=path.join(__dirname,'work',slug(school),slug(`${P.x.className}-${P.x.section}-${P.x.subject}-${P.x.assessmentTitle}`)); fs.mkdirSync(dir,{recursive:true}); fs.mkdirSync(path.join(dir,'pages'),{recursive:true}); fs.mkdirSync(path.join(dir,'feedback'),{recursive:true});
  const meta=(await P.ref.collection('submissions').doc('_meta').collection('detail').doc('osm').get()).data()||{};
  const subs=await P.ref.collection('submissions').listDocuments(); // phantom docs are included by listDocuments
  const students=[]; const skipped=[];
  for(const sd of subs){ if(sd.id==='_meta')continue; const det=await sd.collection('detail').get(); const osm=det.docs.find(d=>d.id==='osm')?.data(); if(!osm||!osm.pages?.length)continue;
   const ink={}; det.docs.filter(d=>d.id.startsWith('osmInk_')).forEach(d=>ink[d.id.slice(7)]=d.data());
   students.push({studentUid:sd.id,osm,ink}); }
  const man={paper:{owner:P.owner,id:P.id,title:P.x.assessmentTitle,className:P.x.className,section:P.x.section,subject:P.x.subject,stream:P.x.stream||'',schoolName:school,declaredTotal:P.x.totalMarks,board:P.x.board||''},questions:P.x.questions,meta,students:[]};
  const { computeOrLoserQNums } = require('./orRule');
  for(const s of students){ const o=s.osm; const marks=o.marks||{}; const nq=P.x.questions.length; const markedAll=P.x.questions.every((_,i)=>marks['q'+i]!==undefined);
   const contributors=[...new Set(Object.values(marks).map(m=>m.by))]; const need=Object.entries(meta.assign||{}).filter(([,a])=>a?.length).map(([u])=>u); const needed=need.length?need:contributors; const done=Object.keys(o.done||{});
   const ready=markedAll&&needed.length>0&&needed.every(u=>done.includes(u));
   if(!ready){skipped.push(`${o.rollNumber} ${o.studentName} (marked ${Object.keys(marks).length}/${nq}, done by ${done.length}/${needed.length})`);continue;}
   const reports=P.x.questions.map((q,i)=>({questionNumber:q.questionNumber||String(i+1),marksAwarded:marks['q'+i].v,maxMarksForQuestion:Number(q.marks)||0,checkingInstructions:q.checkingInstructions||''}));
   const losers=[...computeOrLoserQNums(reports,P.x.questions)]; const total=reports.filter(r=>!losers.includes(r.questionNumber)).reduce((a,r)=>a+r.marksAwarded,0);
   const files=[]; for(let i=0;i<o.pages.length;i++){ const f=path.join(dir,'pages',`${o.rollNumber||s.studentUid}_p${i+1}.jpg`); if(!fs.existsSync(f)){ const tmp=f+'.src'; await dl(o.pages[i].url,tmp); try{cp.execSync(`sips -s format jpeg -Z 1700 "${tmp}" --out "${f}" >/dev/null 2>&1`);}catch{fs.copyFileSync(tmp,f);} fs.unlinkSync(tmp);} 
     let dims={w:0,h:0}; try{const r=cp.execSync(`sips -g pixelWidth -g pixelHeight "${f}"`).toString(); dims={w:+/pixelWidth: (\d+)/.exec(r)[1],h:+/pixelHeight: (\d+)/.exec(r)[1]};}catch{} files.push({file:path.relative(dir,f),...dims,url:o.pages[i].url}); }
   man.students.push({studentUid:s.studentUid,name:o.studentName,roll:o.rollNumber,total,declaredTotal:P.x.totalMarks,losers,marks:Object.fromEntries(P.x.questions.map((q,i)=>[q.questionNumber||String(i+1),{marks:marks['q'+i].v,max:Number(q.marks)||0,by:marks['q'+i].n}])),pages:files,ink:s.ink,teachers:Object.values(o.done||{}).map(d=>d.n)}); }
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(man,null,1));
  console.log(`\nPAPER: ${man.paper.title} — Class ${man.paper.className}${man.paper.section} ${man.paper.subject}\n  exported ${man.students.length} ready student(s) -> ${dir}\n  skipped (not ready): ${skipped.length?skipped.join('; '):'none'}`);
 }
 if(!best.size) console.log('No Teacher Marking papers found for that filter.');
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
