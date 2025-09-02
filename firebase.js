// firebase.js — Firebase Web v12.2.1 (CDN) — Google Sign-in somente

export const firebaseConfig = {
  apiKey: "AIzaSyCP3RH4aR-sSbB7CeZV6c6cpj9fC4HjhCw",
  authDomain: "championschessifma.firebaseapp.com",
  projectId: "championschessifma",
  storageBucket: "championschessifma.firebasestorage.app",
  messagingSenderId: "341916270688",
  appId: "1:341916270688:web:eea60783f83c4a002cc305",
  measurementId: "G-CRQSG5KVHY"
};

// ---- SDK imports (CDN v12.2.1) ----
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAnalytics }   from "https://www.gstatic.com/firebasejs/12.2.1/firebase-analytics.js";
import {
  getAuth, onAuthStateChanged, signOut,
  setPersistence, browserLocalPersistence,
  GoogleAuthProvider, signInWithPopup, updateProfile
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

// ---- Init ----
export const app = initializeApp(firebaseConfig);
export const analytics = getAnalytics(app);

export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence);

export const db = getFirestore(app);

// ---- Auth helpers (Google only) ----
export async function loginWithGoogle(){
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider);
}
export async function setDisplayName(user, name){
  try { await updateProfile(user, { displayName: name }); } catch(_) {}
}
export async function logout(){ return signOut(auth); }
export function watchAuth(cb){ return onAuthStateChanged(auth, cb); }

// ---- Admin check ----
// Admin = documento em /admins/{uid} com { active: true }
export async function isAdmin(uid){
  if(!uid) return false;
  const refDoc = doc(db, "admins", uid);
  const snap = await getDoc(refDoc);
  return snap.exists() && !!snap.data().active;
}

// ---- Reexport Firestore utils ----
export {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where, serverTimestamp
};
