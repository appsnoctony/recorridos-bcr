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
   ================================================================ */
const FirebaseSync = (function(){
  let db = null, ready = false;
  const COL = { meta:'meta', questions:'questions', runs:'runs' };
  const LOCAL_KEY = 'mantcap_db_v3';
  const LASTSYNC_KEY = 'mantcap_lastsync';

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

  return { init, pull, push, syncNow, isConfigured, isOnline, lastSync };
})();
window.FirebaseSync = FirebaseSync;
