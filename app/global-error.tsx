"use client";
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
          background: "#f7f6f3",
          color: "#37352f",
          minHeight: "100vh",
          margin: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 480, padding: 24 }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>🔥</div>
          <h1 style={{ fontSize: 28, fontWeight: 600, margin: 0 }}>
            Something went wrong
          </h1>
          <p style={{ marginTop: 12, color: "#73726c" }}>
            {error.message ||
              "An unexpected error stopped the app. Reloading usually fixes it."}
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: 20,
              padding: "8px 18px",
              background: "#2383e2",
              color: "white",
              border: "none",
              borderRadius: 7,
              cursor: "pointer",
              boxShadow: "0 1px 2px rgba(35,131,226,0.25)",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
