// Usage: node export.js "<School Name>" [className] [section] [subject]
// Finds Teacher Marking papers (assessmentMode 'osm') whose students are READY (all questions marked,
// every contributing teacher clicked Marks Given) and exports marks + page images to ./work/<paper>/
// so Claude can read the handwriting and write feedback. READ-ONLY on Firestore.
const {db}=require('./common'); const fs=require('fs'),path=require('path'),https=require('https'),cp=require('child_process');
const [,, school, fc, fs_, fsub]=process.argv; if(!school){console.log('usage: node export.js "School" [class] [section] [subject]');process.exit(1);}
const slug=s=>String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const dl=(u,f)=>new Promise((res,rej)=>{https.get(u,r=>{if(r.statusCode!==200)return rej(new Error('HTTP '+r.statusCode));const w=fs.createWriteStream(f);r.pipe(w);w.on('finish',()=>w.close(res));}).on('error',rej);});

// ---- teacher annotations: draw them on a copy of the page (so the model can SEE them) and describe them in words ----
const sharp=require('/Users/nikhar/Desktop/Teachers-classmap-Project/vertex-ai-backend/node_modules/sharp');
function strokeBox(st){ if(st.k){const z=+st.w||40;return [st.x-z/2,st.y-z/2,st.x+z/2,st.y+z/2];} if(st.t!==undefined){const fs=+st.w||24;const ls=String(st.t).split('\n');return [st.x,st.y-fs,st.x+Math.max(...ls.map(l=>l.length))*fs*.6,st.y+(ls.length-1)*fs*1.2];}
  const n=(String(st.d||'').match(/-?\d+(?:\.\d+)?/g)||[]).map(Number); const xs=[],ys=[]; for(let k=0;k+1<n.length;k+=2){xs.push(n[k]);ys.push(n[k+1]);} return xs.length?[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]:[0,0,0,0]; }
function describeStroke(st,page){ const b=strokeBox(st).map(v=>Math.round(v)); const kind=st.k==='tick'?'tick':st.k==='cross'?'cross':st.t!==undefined?'text note':(()=>{const w=b[2]-b[0],h=b[3]-b[1]; return h<22&&w>60?'underline / line':(w>90&&h>50?'circle / box / large mark':'pen mark');})();
  return {page,by:st.by,kind,text:st.t,area:{x1:b[0],y1:b[1],x2:b[2],y2:b[3]},note:'coordinates are on a 0-1000 wide page (y grows downward)'}; }
async function renderMarked(file,dims,strokes){
  const H=1000*dims.h/dims.w; const esc=t=>String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const body=strokes.map(st=>{ if(st.k){const z=+st.w||40,x=+st.x,y=+st.y;const d=st.k==='tick'?`M${x-.45*z} ${y+.02*z} L${x-.12*z} ${y+.38*z} L${x+.5*z} ${y-.4*z}`:`M${x-.4*z} ${y-.4*z} L${x+.4*z} ${y+.4*z} M${x+.4*z} ${y-.4*z} L${x-.4*z} ${y+.4*z}`; return `<path d="${d}" stroke="${st.k==='tick'?'#1e8e4e':'#d93025'}" stroke-width="${z*.15}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;}
    if(st.t!==undefined){const fs=+st.w||24;return String(st.t).split('\n').map((l,i)=>`<text x="${st.x}" y="${(+st.y)+i*fs*1.2}" fill="${esc(st.c||'#d93025')}" font-size="${fs}" font-weight="600" font-family="Helvetica,Arial,sans-serif" stroke="#fff" stroke-width="${Math.max(3,fs/6)}" paint-order="stroke">${esc(l)}</text>`).join('');}
    return `<path d="${esc(st.d||'')}" stroke="${esc(st.c||'#d93025')}" stroke-width="${+st.w||3}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`; }).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${dims.w}" height="${dims.h}" viewBox="0 0 1000 ${H.toFixed(1)}" preserveAspectRatio="none">${body}</svg>`;
  const out=file.replace(/\.jpg$/,'_marked.jpg'); await sharp(file).composite([{input:Buffer.from(svg),top:0,left:0}]).jpeg({quality:85}).toFile(out); return out;
}
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
  for(const sd of subs){ if(sd.id==='_meta')continue; if((await sd.get()).exists&&!process.argv.includes('--redo')){skipped.push(sd.id+' already analysed (use --redo to export again)');continue;} const det=await sd.collection('detail').get(); const osm=det.docs.find(d=>d.id==='osm')?.data(); if(!osm||!osm.pages?.length)continue;
   const ink={}; det.docs.filter(d=>d.id.startsWith('osmInk_')).forEach(d=>ink[d.id.slice(7)]=d.data());
   students.push({studentUid:sd.id,osm,ink}); }
  const man={paper:{owner:P.owner,id:P.id,title:P.x.assessmentTitle,className:P.x.className,section:P.x.section,subject:P.x.subject,stream:P.x.stream||'',schoolName:school,declaredTotal:P.x.totalMarks,board:P.x.board||''},questions:P.x.questions,meta,students:[]};
  const { computeOrLoserQNums } = require('./orRule');
  for(const s of students){ const o=s.osm; const marks=o.marks||{}; const nq=P.x.questions.length; const markedAll=P.x.questions.every((_,i)=>marks['q'+i]!==undefined);
   const contributors=[...new Set(Object.values(marks).map(m=>m.by))]; const need=Object.entries(meta.assign||{}).filter(([,a])=>a?.length).map(([u])=>u); const needed=contributors;   // only the teachers who marked this student must have clicked Completed const done=Object.keys(o.done||{});
   const ready=markedAll&&needed.length>0&&(process.argv.includes('--force-ready')||needed.every(u=>done.includes(u)));   // --force-ready: only when the owner has asked for the analysis before the teachers click Completed
   if(!ready){skipped.push(`${o.rollNumber} ${o.studentName} (marked ${Object.keys(marks).length}/${nq}, done by ${done.length}/${needed.length})`);continue;}
   const reports=P.x.questions.map((q,i)=>({questionNumber:q.questionNumber||String(i+1),marksAwarded:marks['q'+i].v,maxMarksForQuestion:Number(q.marks)||0,checkingInstructions:q.checkingInstructions||''}));
   const losers=[...computeOrLoserQNums(reports,P.x.questions)]; const total=reports.filter(r=>!losers.includes(r.questionNumber)).reduce((a,r)=>a+r.marksAwarded,0);
   const files=[]; for(let i=0;i<o.pages.length;i++){ const f=path.join(dir,'pages',`${o.rollNumber||s.studentUid}_p${i+1}.jpg`); if(!fs.existsSync(f)){ const tmp=f+'.src'; await dl(o.pages[i].url,tmp); try{cp.execSync(`sips -s format jpeg -Z 1700 "${tmp}" --out "${f}" >/dev/null 2>&1`);}catch{fs.copyFileSync(tmp,f);} fs.unlinkSync(tmp);} 
     let dims={w:0,h:0}; try{const r=cp.execSync(`sips -g pixelWidth -g pixelHeight "${f}"`).toString(); dims={w:+/pixelWidth: (\d+)/.exec(r)[1],h:+/pixelHeight: (\d+)/.exec(r)[1]};}catch{} const strokes=[]; Object.entries(s.ink||{}).forEach(([tu,d])=>{ if((d.pv??null)!==(o.pagesVersion??null))return; ((d.pages||{})[String(i)]||[]).forEach(st=>strokes.push({...st,by:d.teacherName||tu})); });
     let marked=null; if(strokes.length&&dims.w){ try{ marked=await renderMarked(f,dims,strokes); }catch(e){ console.log('  (could not draw teacher marks on page',i+1,e.message+')'); } }
     files.push({file:path.relative(dir,f),...dims,url:o.pages[i].url,...(marked?{markedFile:path.relative(dir,marked)}:{}),annotations:strokes.map(st=>describeStroke(st,i+1))}); }
   man.students.push({studentUid:s.studentUid,name:o.studentName,roll:o.rollNumber,total,declaredTotal:P.x.totalMarks,losers,marks:Object.fromEntries(P.x.questions.map((q,i)=>[q.questionNumber||String(i+1),{marks:marks['q'+i].v,max:Number(q.marks)||0,by:marks['q'+i].n,na:!!marks['q'+i].na}])),pages:files,teacherNotes:Object.fromEntries(Object.entries(o.notes||{}).map(([k,v])=>[(P.x.questions[+k.slice(1)]||{}).questionNumber||k,{text:v.t,by:v.n}])),ink:s.ink,notes:Object.values(s.ink||{}).flatMap(d=>Object.entries(d.pages||{}).flatMap(([pg,arr])=>(arr||[]).filter(a=>a.t!==undefined).map(a=>({page:Number(pg)+1,teacher:d.teacherName||'',text:a.t})))),teachers:Object.values(o.done||{}).map(d=>d.n)}); }
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(man,null,1));
  console.log(`\nPAPER: ${man.paper.title} — Class ${man.paper.className}${man.paper.section} ${man.paper.subject}\n  exported ${man.students.length} ready student(s) -> ${dir}\n  skipped (not ready): ${skipped.length?skipped.join('; '):'none'}`);
 }
 if(!best.size) console.log('No Teacher Marking papers found for that filter.');
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
