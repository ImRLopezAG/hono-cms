async function fetchPosts() {
  const res = await fetch("http://127.0.0.1:8788/api/posts", {
    headers: { authorization: "Bearer admin" },
    cache: "no-store"
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function Page() {
  const data = await fetchPosts();
  return (
    <main style={{ padding: 32, maxWidth: 720, margin: "0 auto" }}>
      <p style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8" }}>
        Hono CMS on Next.js
      </p>
      <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" }}>Posts</h1>
      <p style={{ color: "#475569", fontSize: 14 }}>
        Same `createCMS` served via Next.js App Router route handlers at <code>/api/cms/*</code>.
      </p>
      <pre style={{ background: "#f8fafc", padding: 16, borderRadius: 8, fontSize: 12, overflow: "auto" }}>
        {JSON.stringify(data, null, 2)}
      </pre>
      <p style={{ fontSize: 12, color: "#94a3b8" }}>
        Drive the admin at <code>http://127.0.0.1:5173/settings/content-types/visualizer</code> with{" "}
        <code>VITE_CMS_API_URL=http://127.0.0.1:8788</code>.
      </p>
    </main>
  );
}
