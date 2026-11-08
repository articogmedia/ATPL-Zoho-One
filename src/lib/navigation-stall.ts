export type NavigationClick = {
  defaultPrevented: boolean;
  button: number;
  modified: boolean;
  href: string;
  target: string;
  download: boolean;
};

export function trackableNavigation(
  click: NavigationClick,
  currentHref: string,
): { href: string; routeKey: string } | null {
  if (!click.defaultPrevented || click.button !== 0 || click.modified || click.target === "_blank" || click.download) return null;
  try {
    const current = new URL(currentHref);
    const target = new URL(click.href, current);
    if (!["http:", "https:"].includes(target.protocol) || target.origin !== current.origin) return null;
    const currentRouteKey = `${current.pathname}?${new URLSearchParams(current.searchParams).toString()}`;
    const routeKey = `${target.pathname}?${new URLSearchParams(target.searchParams).toString()}`;
    if (routeKey === currentRouteKey) return null;
    return { href: target.href, routeKey };
  } catch {
    return null;
  }
}
