// ============================================================
// ARENAFLOW — CONFIGURAÇÃO DO FIREBASE
// Substitua os valores abaixo com as credenciais do seu projeto
// Firebase Console → Project Settings → Your Apps → Web App
// ============================================================

const FIREBASE_CONFIG = {
  apiKey: "SUA_API_KEY_AQUI",
  authDomain: "seu-projeto.firebaseapp.com",
  projectId: "seu-projeto",
  storageBucket: "seu-projeto.appspot.com",
  messagingSenderId: "SEU_SENDER_ID",
  appId: "SEU_APP_ID"
};

// ID do Superadmin (seu UID do Firebase Auth)
// Após criar sua conta, vá ao Firebase Console → Authentication → Users → copie seu UID
const SUPERADMIN_UID = "SEU_UID_DE_SUPERADMIN_AQUI";

// Inicializar Firebase
firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.firestore();

// Configurações do Firestore offline
db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
