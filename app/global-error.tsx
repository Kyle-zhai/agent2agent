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
          background: "#fbfbfa",
          color: "#2f3437",
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
            Server crashed
          </h1>
          <p style={{ marginTop: 12, color: "#787774" }}>
            {error.message || "Unexpected fatal error."}
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: 20,
              padding: "8px 18px",
              background: "#2f3437",
              color: "white",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
