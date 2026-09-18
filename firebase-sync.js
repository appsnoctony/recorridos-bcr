/* ================================================================
   MantCAP · Adaptador de sincronización con Cloud Firestore
   - Estructura en la nube:
       /meta/mantcap      → configuración general (usuarios, ajustes)
       /questions/{id}    → cada pregunta del checklist
       /runs/{id}         → cada recorrido (informe)
   - Offline-first: localStorage es la caché local; si no hay
     internet la app sigue funcionando y sincroniza al volver.
   - Guardado con debounce de 2 s para no gastar cuota.
   ================================================================ */
const FirebaseSync = (function(){
  let db = null, ready = false;
  const COL = { meta:'meta', questions:'questions', runs:'runs' };
  const LOCAL_KEY = 'mantcap_db_v3';

  /* ¿Está configurado el proyecto? (detecta los placeholders) */
  function isConfigured(){
    return typeof FIREBASE_CONFIG !== 'undefined' &&
           FIREBASE_CONFIG.apiKey &&
           !String(FIREBASE_CONFIG.apiKey).startsWith('PEGA');
  }

  function init(){
    if(!isConfigured()){
      console.warn('[FirebaseSync] Sin configuración — modo solo local (localStorage).');
      return Promise.resolve(false);
    }
    try{
      firebase.initializeApp(FIREBASE_CONFIG);
    }catch(e){
      console.warn('[FirebaseSync] Error al inicializar Firebase:', e.message);
      return Promise.resolve(false);
    }
    /* Login anónimo: identifica la app ante las reglas de Firestore */
    return firebase.auth().signInAnonymously()
      .then(() => {
        db = firebase.firestore();
        ready = true;
        console.log('[FirebaseSync] ✓ Conectado a Firebase');
        return true;
      })
      .catch(e => {
        console.warn('[FirebaseSync] No se pudo conectar:', e.code, e.message);
        return false;
      });
  }

  /* Descarga el estado remoto. Si la nube está vacía pero hay datos
     locales (primer uso), los migra automáticamente a la nube. */
  async function pull(){
    if(!ready) return null;
    const metaSnap = await db.collection(COL.meta).doc('mantcap').get();
    if(!metaSnap.exists){
      const local = localStorage.getItem(LOCAL_KEY);
      if(local){
        try{
          await doPush(JSON.parse(local));
          console.log('[FirebaseSync] ✓ Datos locales migrados a la nube');
        }catch(e){
          console.warn('[FirebaseSync] No se pudo migrar:', e.message);
        }
      }
      return null;
    }
    const meta = metaSnap.data();
    const qs = await db.collection(COL.questions).get();
    const rs = await db.collection(COL.runs).get();
    return {
      v: meta.v,
      qseq: meta.qseq,
      questions: qs.docs.map(d => d.data()),
      settings: meta.settings || { pinned: [] },
      users: meta.users || [],
      runs: rs.docs.map(d => d.data())
    };
  }

  /* Guardado diferido (debounce 2 s): agrupa varios cambios seguidos */
  let pushTimer = null;
  function push(DB){
    if(!ready || !DB) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      doPush(DB).catch(e =>
        console.warn('[FirebaseSync] Error al guardar en la nube:', e.message));
    }, 2000);
  }

  async function doPush(DB){
    if(!ready || !DB) return;
    /* Firestore: máx. 500 operaciones por batch → fragmentamos */
    const ops = [];
    ops.push({
      ref: db.collection(COL.meta).doc('mantcap'),
      data: {
        v: DB.v,
        qseq: DB.qseq,
        users: DB.users,
        settings: DB.settings || { pinned: [] },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }
    });
    DB.questions.forEach(q => ops.push({ ref: db.collection(COL.questions).doc(q.id), data: q }));
    DB.runs.forEach(r => ops.push({ ref: db.collection(COL.runs).doc(r.id), data: r }));
    for(let i = 0; i < ops.length; i += 400){
      const batch = db.batch();
      ops.slice(i, i + 400).forEach(o => batch.set(o.ref, o.data));
      await batch.commit();
    }
    console.log('[FirebaseSync] ✓ Guardado en la nube (' + ops.length + ' documentos)');
  }

  return { init, pull, push, isConfigured };
})();
window.FirebaseSync = FirebaseSync;