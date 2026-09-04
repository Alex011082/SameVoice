export function profileUrl(currentHref: string, userId: string): string {
  const url = new URL(currentHref);
  url.searchParams.set('me', userId);
  return url.toString();
}
