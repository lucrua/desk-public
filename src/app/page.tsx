import { redirect } from "next/navigation";

// The hub has no landing page — the docs list is the front door.
// (On the share host this route is already 404-guarded by the middleware.)
export default function Home() {
  redirect("/docs");
}
