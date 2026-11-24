// Paths the UI understands. The Worker serves index.html for each of them.

export type Route =
  | { name: "home" }
  | { name: "project"; projectId: string }
  | { name: "manage"; projectId: string }
  | { name: "notFound" };

const SEGMENT = /^[A-Za-z0-9._-]+$/;

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter((p) => p !== "");
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "p" && SEGMENT.test(parts[1] ?? "")) {
    if (parts.length === 2) return { name: "project", projectId: parts[1] as string };
    if (parts.length === 3 && parts[2] === "manage") return { name: "manage", projectId: parts[1] as string };
  }
  return { name: "notFound" };
}

export function routePath(route: Route): string {
  switch (route.name) {
    case "home":
      return "/";
    case "project":
      return `/p/${encodeURIComponent(route.projectId)}`;
    case "manage":
      return `/p/${encodeURIComponent(route.projectId)}/manage`;
    case "notFound":
      return "/";
  }
}
