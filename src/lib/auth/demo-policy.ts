export function productionDemoLoginAllowed(
  nodeEnv: string,
  authMode: string,
  allowed: boolean,
  productionAllowed: boolean,
): boolean {
  return authMode === "demo" && allowed && (nodeEnv !== "production" || productionAllowed);
}
