export function matchesResourceScope(resource: string, scope: string): boolean {
  if (scope === resource) return true;
  if (!scope.endsWith("/*")) return false;
  const prefix = scope.slice(0, -1);
  return resource.length > prefix.length && resource.startsWith(prefix);
}

export function isResourceScopeSubset(
  requestedScope: string,
  parentScopes: readonly string[],
): boolean {
  if (!requestedScope.endsWith("/*")) {
    return parentScopes.some((scope) => matchesResourceScope(requestedScope, scope));
  }
  const requestedPrefix = requestedScope.slice(0, -1);
  return parentScopes.some((scope) => {
    if (!scope.endsWith("/*")) return false;
    const parentPrefix = scope.slice(0, -1);
    return requestedPrefix.startsWith(parentPrefix);
  });
}
