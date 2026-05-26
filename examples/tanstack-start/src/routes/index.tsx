import { createFileRoute } from "@tanstack/react-router";

type PostsResponse = {
  data?: Array<{ id: string; title?: string; slug?: string; status?: string }>;
} | null;

export const Route = createFileRoute("/")({
  loader: async () => {
    try {
      const res = await fetch("http://127.0.0.1:8790/api/cms/api/posts", {
        headers: { authorization: "Bearer admin" }
      });
      if (!res.ok) return null;
      return (await res.json()) as PostsResponse;
    } catch {
      return null;
    }
  },
  component: IndexPage
});

function IndexPage() {
  const data = Route.useLoaderData();
  return (
    <main style={{ padding: 32, maxWidth: 720, margin: "0 auto" }}>
      <p style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8" }}>
        Hono CMS on TanStack Start
      </p>
      <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" }}>Posts</h1>
      <p style={{ color: "#475569", fontSize: 14 }}>
        Same <code>createCMS</code> served via a TanStack Start API file route at <code>/api/cms/*</code>.
      </p>
      <pre style={{ background: "#f8fafc", padding: 16, borderRadius: 8, fontSize: 12, overflow: "auto" }}>
        {JSON.stringify(data, null, 2)}
      </pre>
      <p style={{ fontSize: 12, color: "#94a3b8" }}>
        Drive the admin at <code>http://127.0.0.1:5173/settings/content-types/visualizer</code> with{" "}
        <code>VITE_CMS_API_URL=http://127.0.0.1:8790</code>.
      </p>
    </main>
  );
}
