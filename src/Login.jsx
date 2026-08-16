import { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "./firebase.js";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      const known = ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"];
      setError(
        known.includes(err.code)
          ? "Email ou mot de passe incorrect."
          : "Impossible de se connecter" + (err.message ? ` (${err.message})` : "") + "."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#E9F3EA",
        fontFamily: "'Inter', sans-serif",
        padding: 16,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          background: "#FFFFFF",
          border: "1px solid #CFE5D2",
          borderRadius: 16,
          padding: 32,
          width: "100%",
          maxWidth: 360,
          boxShadow: "0 4px 20px rgba(15,42,28,0.08)",
        }}
      >
        <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "1.4rem", color: "#0F2A1C", marginBottom: 24 }}>
          Suivi Comptes
        </h1>
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "#4B5D52", marginBottom: 4 }}>
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            style={{ width: "100%", padding: "8px 12px", borderRadius: 12, border: "1px solid #CFE0D3", outline: "none", boxSizing: "border-box", fontSize: 14 }}
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "#4B5D52", marginBottom: 4 }}>
            Mot de passe
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ width: "100%", padding: "8px 12px", borderRadius: 12, border: "1px solid #CFE0D3", outline: "none", boxSizing: "border-box", fontSize: 14 }}
          />
        </div>
        {error && <p style={{ fontSize: 12, color: "#C2410C", marginBottom: 12 }}>{error}</p>}
        <button
          type="submit"
          disabled={loading}
          style={{
            width: "100%",
            padding: "10px",
            borderRadius: 12,
            border: "none",
            color: "#FFFFFF",
            background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)",
            fontSize: 14,
            cursor: loading ? "default" : "pointer",
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? "Connexion…" : "Se connecter"}
        </button>
      </form>
    </div>
  );
}
