import "./storage-shim.js";
import "./index.css";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "./firebase.js";
import App from "./App.jsx";
import Login from "./Login.jsx";

function Root() {
  // undefined = still checking, null = logged out, object = logged in
  const [user, setUser] = useState(undefined);

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  if (user === undefined) {
    return <div style={{ minHeight: "100vh", background: "#E9F3EA" }} />;
  }
  if (!user) {
    return <Login />;
  }
  return (
    <>
      <App />
      <button
        onClick={() => signOut(auth)}
        title={`Connecté en tant que ${user.email}`}
        style={{
          position: "fixed",
          bottom: 12,
          right: 12,
          zIndex: 9999,
          fontSize: 11,
          padding: "6px 10px",
          borderRadius: 8,
          border: "1px solid #CFE5D2",
          background: "#FFFFFF",
          color: "#4B5D52",
          cursor: "pointer",
          boxShadow: "0 2px 8px rgba(15,42,28,0.12)",
        }}
      >
        Déconnexion
      </button>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
