// firebase.js — SDK v12.2.1 (CDN) com Firestore + Auth + Storage

// ---- SUA CONFIG ----
export const firebaseConfig = {
  apiKey: "AIzaSyCP3RH4aR-sSbB7CeZV6c6cpj9fC4HjhCw",
  authDomain: "championschessifma.firebaseapp.com",
  projectId: "championschessifma",
  storageBucket: "championschessifma.firebasestorage.app",
  messagingSenderId: "341916270688",
  appId: "1:341916270688:web:eea60783f83c4a002cc305",
  measurementId: "G-CRQSG5KVHY"
};

// ---- IMPORTS v12.2.1 ----
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAnalytics }   from "https://www.gstatic.com/firebasejs/12.2.1/firebase-analytics.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
  setPersistence, browserLocalPersistence, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-storage.js";

// ---- INIT ----
export const app = initializeApp(firebaseConfig);
export const analytics = getAnalytics(app);
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence);
export const db = getFirestore(app);
export const storage = getStorage(app);

// ---- HELPERS ----
export async function loginEmailPassword(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}
export async function signupEmailPassword(email, password){
  return createUserWithEmailAndPassword(auth, email, password);
}
export async function logout(){ return signOut(auth); }
export function watchAuth(cb){ return onAuthStateChanged(auth, cb); }

// Admin = documento em /admins/{uid} com {active:true}
export async function isAdmin(uid){
  if(!uid) return false;
  const refDoc = doc(db, "admins", uid);
  const snap = await getDoc(refDoc);
  return snap.exists() && !!snap.data().active;
}

// Reexport utils p/ app.js
export {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where, serverTimestamp,
  ref, uploadBytes, getDownloadURL
};
