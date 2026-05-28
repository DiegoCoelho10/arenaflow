const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDauzK1C4o19nd8WyR51AZ_bNa3s2InU1E",
  authDomain: "arenaflow-37b2f.firebaseapp.com",
  projectId: "arenaflow-37b2f",
  storageBucket: "arenaflow-37b2f.firebasestorage.app",
  messagingSenderId: "777130757869",
  appId: "1:777130757869:web:8b1aae200246a0b71246e4"
};

const SUPERADMIN_UID = "SEU_UID_AQUI";

firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.firestore();
db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
