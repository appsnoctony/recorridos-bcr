/* ================================================================
   MantCAP · Adaptador de sincronización con Cloud Firestore
   - Estructura en la nube:
       /meta/mantcap      → configuración general (usuarios, ajustes)
       /questions/{id}    → cada pregunta del checklist
       /runs/{id}         → cada recorrido (informe)
   - Offline-first: localStorage es la caché local. Sin internet
     la app funciona normal y sincroniza al reconectar.
   - v3.1: sincronización manual (pull+push), estado de conexión,
     última sincronización, reintento automático y resolución de
     conflictos por fecha (gana el cambio más reciente).
   - v3.2: las preguntas eliminadas en la app (DB.deletedQ) también
     se borran de Firestore, para que no vuelvan a aparecer.
   - v3.3: doPush() ya NO reescribe todas las preguntas y todos los
     recorridos en cada sincronización. Ahora guarda una huella
     (fingerprint) de lo último subido y solo envía a Firestore los
     documentos que realmente cambiaron desde el push anterior. Esto
     evita que el número de escrituras crezca sin límite a medida
     que se acumulan recorridos con los años.
   ================================================================ */
const FirebaseSync = (function(){
  let db = null, ready = false;
  const COL = { meta:'meta', questions:'questions', runs:'runs' };
  const LOCAL_KEY = 'mantcap_db_v3';
  const LASTSYNC_KEY = 'mantcap_lastsync';
  const FP_KEY = 'mantcap_pushed_fp'; // huellas de lo último subido a Firestore

  /* ¿Está configurado el proyecto? */
  function isConfigured(){
    return typeof FIREBASE_CONFIG !== 'undefined' &&
           FIREBASE_CONFIG.apiKey &&
           !String(FIREBASE_CONFIG.apiKey).startsWith('PEGA');
  }

  /* ¿Hay conexión ahora mismo? */
  function isOnline(){
    return navigator.onLine !== false;
  }

  /* Última sincronización exitosa (ISO o null) */
  function lastSync(){
    try{ return localStorage.getItem(LASTSYNC_KEY) || null; }catch(_){ return null; }
  }
  function setLastSync(){
    try{ localStorage.setItem(LASTSYNC_KEY,new Date().toISOString()); }catch(_){}
  }

  /* ---------- Huellas de documentos ya subidos (v3.3) ---------- */
  function loadFP(){
    try{
      const raw = localStorage.getItem(FP_KEY);
      const fp = raw ? JSON.parse(raw) : null;
      return (fp && fp.questions && fp.runs) ? fp : { questions:{}, runs:{} };
    }catch(_){ return { questions:{}, runs:{} }; }
  }
  function saveFP(fp){
    try{ localStorage.setItem(FP_KEY, JSON.stringify(fp)); }catch(_){}
  }
  /* Hash simple y rápido (no criptográfico) — solo necesita detectar
     si el contenido de un documento cambió desde el último push. */
  function fingerprint(obj){
    const s = JSON.stringify(obj);
    let h = 0;
    for(let i=0;i<s.length;i++){ h = (h*31 + s.charCodeAt(i)) | 0; }
    return h + ':' + s.length;
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
        /* Al volver la conexión, reenvía lo pendiente */
        window.addEventListener('online', () => {
          console.log('[FirebaseSync] Conexión restaurada — sincronizando cambios pendientes…');
          syncNow(true);
        });
        console.log('[FirebaseSync] ✓ Conectado a Firebase');
        return true;
      })
      .catch(e => {
        console.warn('[FirebaseSync] No se pudo conectar:', e.code, e.message);
        return false;
      });
  }

  /* Reenvía el estado local completo */
  function retryPending(){
    try{
      const raw = localStorage.getItem(LOCAL_KEY);
      if(!raw) return Promise.resolve();
      return doPush(JSON.parse(raw));
    }catch(_){ return Promise.resolve(); }
  }

  /* Comparar fechas: ¿este dispositivo tiene cambios más recientes que la nube? */
  function localNewerThan(remoteT){
    let localDB = null;
    try{
      const localRaw = localStorage.getItem(LOCAL_KEY);
      localDB = localRaw ? JSON.parse(localRaw) : null;
    }catch(_){}
    const localT = (localDB && localDB.updatedAt) ? new Date(localDB.updatedAt).getTime() : 0;
    return { newer: localT > remoteT + 1000, local: localDB };
  }

  /* Descarga el estado remoto. Si la nube está vacía pero hay datos
     locales (primer uso), los migra. Si el dispositivo tiene cambios
     MÁS RECIENTES que la nube (trabajó offline), los sube en vez de
     sobrescribirlos — gana siempre el más reciente. */
  async function pull(){
    if(!ready) return null;
    const metaSnap = await db.collection(COL.meta).doc('mantcap').get();
    if(!metaSnap.exists){
      const local = localStorage.getItem(LOCAL_KEY);
      if(local){
        try{
          await doPush(JSON.parse(local));
          setLastSync();
          console.log('[FirebaseSync] ✓ Datos locales migrados a la nube');
        }catch(e){
          console.warn('[FirebaseSync] No se pudo migrar:', e.message);
        }
      }
      return null;
    }
    const meta = metaSnap.data();
    const remoteT = (meta.updatedAt && meta.updatedAt.toDate) ? meta.updatedAt.toDate().getTime() : 0;
    const { newer, local } = localNewerThan(remoteT);
    if(newer && local){
      /* Este dispositivo tiene cambios más nuevos (trabajó offline) */
      try{
        await doPush(local);
        setLastSync();
        console.log('[FirebaseSync] ✓ Cambios locales (más recientes) subidos a la nube');
      }catch(e){
        console.warn('[FirebaseSync] Pendiente de subir, se reintentará:', e.message);
      }
      return null; /* conservar los datos locales (son los ganadores) */
    }
    const qs = await db.collection(COL.questions).get();
    const rs = await db.collection(COL.runs).get();
    setLastSync();
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
      doPush(DB).then(()=>setLastSync()).catch(e =>
        console.warn('[FirebaseSync] Sin conexión o error — se sincronizará al reconectar:', e.message));
    }, 2000);
  }

  /* SINCRONIZACIÓN MANUAL: sube lo local y baja lo remoto en un paso.
     Devuelve {ok, msg} para mostrar al usuario. */
  async function syncNow(silent){
    if(!ready){
      if(!silent) return {ok:false,msg:'❌ Firebase no está configurado'};
      return {ok:false};
    }
    if(!isOnline()){
      if(!silent) return {ok:false,msg:'📴 Sin conexión — los datos están seguros en este dispositivo y se sincronizarán al reconectar'};
      return {ok:false};
    }
    try{
      /* 1) Subir estado local */
      const raw = localStorage.getItem(LOCAL_KEY);
      if(raw) await doPush(JSON.parse(raw));
      /* 2) Bajar estado remoto y aplicarlo si es más nuevo */
      const remote = await pull();
      if(remote){
        localStorage.setItem(LOCAL_KEY, JSON.stringify(remote));
      }
      setLastSync();
      if(!silent){
        console.log('[FirebaseSync] ✓ Sincronización manual completa');
        return {ok:true,msg:'☁️ Sincronización completada ✓'};
      }
      return {ok:true};
    }catch(e){
      console.warn('[FirebaseSync] Error en sincronización:', e.message);
      if(!silent) return {ok:false,msg:'⚠ No se pudo sincronizar: '+e.message};
      return {ok:false};
    }
  }

  /* v3.3: solo sube a Firestore los documentos (preguntas / recorridos)
     cuyo contenido cambió desde el último push exitoso. El documento
     /meta/mantcap se sigue subiendo siempre porque es pequeño y no
     crece con el historial. */
  async function doPush(DB){
    if(!ready || !DB) return;
    const fp = loadFP();
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

    const newQFP = {}, newRFP = {};
    let skippedQ = 0, skippedR = 0;

    DB.questions.forEach(q => {
      const h = fingerprint(q);
      newQFP[q.id] = h;
      if(fp.questions[q.id] === h){ skippedQ++; return; } // sin cambios → no se sube
      ops.push({ ref: db.collection(COL.questions).doc(q.id), data: q });
    });

    DB.runs.forEach(r => {
      const h = fingerprint(r);
      newRFP[r.id] = h;
      if(fp.runs[r.id] === h){ skippedR++; return; } // sin cambios → no se sube
      ops.push({ ref: db.collection(COL.runs).doc(r.id), data: r });
    });

    /* borrar de la nube las preguntas eliminadas en la app */
    const liveIds = new Set(DB.questions.map(q => q.id));
    const toDelete = (DB.deletedQ || []).filter(id => id && !liveIds.has(id));
    toDelete.forEach(id => ops.push({ ref: db.collection(COL.questions).doc(id), del: true }));

    for(let i = 0; i < ops.length; i += 400){
      const batch = db.batch();
      ops.slice(i, i + 400).forEach(o => o.del ? batch.delete(o.ref) : batch.set(o.ref, o.data));
      await batch.commit();
    }

    /* Actualizar huellas SOLO después de que el push tuvo éxito */
    toDelete.forEach(id => { delete newQFP[id]; });
    saveFP({ questions: newQFP, runs: newRFP });

    if(toDelete.length){
      DB.deletedQ = [];
      console.log('[FirebaseSync] 🧹 ' + toDelete.length + ' preguntas eliminadas de la nube');
    }
    const written = ops.length - toDelete.length;
    console.log('[FirebaseSync] ✓ Guardado en la nube: ' + written + ' documento(s) escrito(s), ' +
      (skippedQ + skippedR) + ' sin cambios (no se reescribieron).');
  }

  return { init, pull, push, syncNow, isConfigured, isOnline, lastSync };
})();
window.FirebaseSync = FirebaseSync;
