// db.js — the ONLY file that talks to Firebase.
//
// index.html never imports Firebase; it calls the functions on window.DB below.
// This file is an ES module, so it can't be seen by index.html's inline onclick
// handlers directly — it publishes its API as window.DB and fires a "db-ready"
// event once loaded.
//
// Firestore layout (see firestore.rules for who may write what):
//   config/app                                { activeSeasonNumber }
//   eras/{eraId}                              { name, number }          era-1 = Legacy, era-2 = current
//   eras/{eraId}/seasons/s{n}                 { name, number, system }  system: "pnl" | "old"
//   eras/{eraId}/seasons/s{n}/sessions/{id}   { seq, name, date, results:[{player,buyin,final}] }
//   players/{name}                            { name }

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, writeBatch, deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Public web config — safe to publish; access is controlled by firestore.rules.
const firebaseConfig = {
  apiKey: "AIzaSyDoIwut-FYHuSq_xm1iBNiu7T25uaU8AeI",
  authDomain: "poker-dashboard-bf0db.firebaseapp.com",
  projectId: "poker-dashboard-bf0db",
  storageBucket: "poker-dashboard-bf0db.firebasestorage.app",
  messagingSenderId: "369133846377",
  appId: "1:369133846377:web:6307c18dfc9d76fef747f8",
};

const db = getFirestore(initializeApp(firebaseConfig));
const LIVE_ERA = "era-2"; // the only era the app ever writes to

// ── Reads ────────────────────────────────────────────────────────────────

// Sessions of one season, in play order.
async function loadSeason(eraId, seasonId) {
  const snap = await getDocs(collection(db, "eras", eraId, "seasons", seasonId, "sessions"));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

// One era with all its seasons and their sessions.
async function loadEra(eraId) {
  const [eraSnap, seasonsSnap] = await Promise.all([
    getDoc(doc(db, "eras", eraId)),
    getDocs(collection(db, "eras", eraId, "seasons")),
  ]);
  if (!eraSnap.exists()) throw new Error(`Era ${eraId} not found`);
  const seasons = await Promise.all(seasonsSnap.docs.map(async s => ({
    id: s.id, ...s.data(), sessions: await loadSeason(eraId, s.id),
  })));
  seasons.sort((a, b) => a.number - b.number);
  return { id: eraId, ...eraSnap.data(), seasons };
}

// Everything the app needs at start-up.
async function loadAll() {
  const [cfgSnap, legacy, live, players] = await Promise.all([
    getDoc(doc(db, "config", "app")),
    loadEra("era-1"),
    loadEra(LIVE_ERA),
    loadPlayers(),
  ]);
  if (!cfgSnap.exists()) throw new Error("config/app not found in Firestore");
  return { activeSeasonNumber: cfgSnap.data().activeSeasonNumber, eras: { "era-1": legacy, [LIVE_ERA]: live }, players };
}

async function loadPlayers() {
  const snap = await getDocs(collection(db, "players"));
  return snap.docs.map(d => d.id).sort((a, b) => a.localeCompare(b));
}

// ── Writes (Era 2 only) ──────────────────────────────────────────────────

// Add (no session.id) or overwrite (session.id set) a session in an Era 2 season.
// Also records any new player names. Returns the session's id.
async function saveSession(seasonId, session) {
  const sessions = collection(db, "eras", LIVE_ERA, "seasons", seasonId, "sessions");
  const ref = session.id ? doc(sessions, session.id) : doc(sessions); // doc(sessions) = new random id
  const data = {
    seq: session.seq,
    name: session.name,
    date: session.date,
    results: session.results.map(r => ({ player: r.player, buyin: r.buyin, final: r.final })),
  };
  const batch = writeBatch(db);
  batch.set(ref, data);
  for (const r of data.results) batch.set(doc(db, "players", r.player), { name: r.player });
  await batch.commit();
  return ref.id;
}

async function deleteSession(seasonId, sessionId) {
  await deleteDoc(doc(db, "eras", LIVE_ERA, "seasons", seasonId, "sessions", sessionId));
}

// Start Era 2 season number currentNumber+1 and make it the active one, in one atomic write.
async function startNewSeason(currentNumber) {
  const number = currentNumber + 1;
  const season = { name: `Season ${number}`, number, system: "pnl" };
  const batch = writeBatch(db);
  batch.set(doc(db, "eras", LIVE_ERA, "seasons", `s${number}`), season);
  batch.update(doc(db, "config", "app"), { activeSeasonNumber: number });
  await batch.commit();
  return { id: `s${number}`, ...season, sessions: [] };
}

window.DB = { loadAll, loadEra, loadSeason, loadPlayers, saveSession, deleteSession, startNewSeason };
window.dispatchEvent(new Event("db-ready"));
