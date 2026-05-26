import {
  buildArticlesQuery,
  createCMSClient,
  type ArticlesPopulated,
  type CMSClient,
  type ID
} from "./generated/sdk";

export type NewsroomSeedResult = {
  authorId: ID;
  articleId: ID;
  query: string;
  listedTitle: string;
  listedAuthor: string;
};

export function createNewsroomClient(fetch: typeof globalThis.fetch, baseUrl = "https://cms.test"): CMSClient {
  return createCMSClient({
    baseUrl,
    token: "admin",
    fetch
  });
}

export async function seedAndReadPublishedArticle(client: CMSClient): Promise<NewsroomSeedResult> {
  const author = await client.authors.create({
    name: "Grace Hopper",
    bio: "Compiler pioneer",
    apiKey: "private"
  });
  const article = await client.articles.create({
    title: "Typed CMS Ships",
    slug: "typed-cms-ships",
    summary: "A generated SDK drives a real app.",
    views: 7,
    authorId: author.id
  });
  await client.articles.publish(article.id);

  const query = buildArticlesQuery({
    filters: { title: { $contains: "Typed" } },
    pagination: { limit: 5 },
    populate: ["author"]
  });
  const result = await client.articles.findMany({
    filters: { title: { $contains: "Typed" } },
    pagination: { limit: 5 },
    populate: ["author"]
  });
  const published = result.items[0] as ArticlesPopulated | undefined;
  if (!published) throw new Error("Expected seeded article to be returned");

  return {
    authorId: author.id,
    articleId: published.id,
    query,
    listedTitle: published.title,
    listedAuthor: published.author.name
  };
}
