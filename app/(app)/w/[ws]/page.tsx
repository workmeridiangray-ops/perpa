import { redirect } from "next/navigation";

export default async function Home({ params }: { params: Promise<{ ws: string }> }) {
  redirect(`/w/${(await params).ws}/clients`);
}
