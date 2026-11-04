const admin=require('/Users/nikhar/Desktop/Teachers-classmap-Project/vertex-ai-backend/node_modules/firebase-admin');
if(!admin.apps.length) admin.initializeApp({credential:admin.credential.cert(require('/Users/nikhar/Desktop/Teachers-classmap-Project/functions/serviceAccountKey.json.json')),storageBucket:process.env.OSM_BUCKET||'student-database-74297.firebasestorage.app'});
module.exports={admin,db:admin.firestore()};
